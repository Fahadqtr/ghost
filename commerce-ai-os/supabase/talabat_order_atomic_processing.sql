-- ============================================================================
-- process_talabat_order_deduction — atomic, all-or-nothing Talabat order
-- deduction. Run ONCE in the Supabase SQL editor of the PRODUCTION project
-- (vqstcmattiarhblqshvb). Idempotent (create or replace + guarded grants).
--
-- The whole body runs in ONE transaction. It takes a per-dedup-key advisory
-- lock FIRST, then locks the order row and every targeted inventory / variant /
-- shelf row FOR UPDATE. The plan is validated and defensively aggregated by
-- (masterProductId, masterVariantSku) so duplicate targets are summed before any
-- stock check. It verifies quantities, stock, and inventory invariants (PASS 1,
-- no writes), then applies everything or nothing (PASS 2, in a subtransaction
-- with per-UPDATE affected-row checks — any mismatch rolls the apply back and
-- parks the order for manual review). It records each movement in `malak_audit`
-- (this project's stock-movement ledger — there is NO stock_movements table),
-- rolls the parent inventory up to the SUM of its variants (never
-- max(parent, variants)), never writes a negative quantity, and never adds a
-- per-channel stock column.
--
-- Only a whitelisted, non-personal projection of the resolution is stored (never
-- the raw payload, customer/phone/address, tokens, headers, or a DB error).
--
-- Column types verified against the live schema: talabat_orders.id / products.id
-- / inventory.id / inventory.product_id / product_variants.id /
-- product_variants.parent_product_id are uuid; shelf_stock.inventory_id and
-- variant_shelf_stock.variant_id are uuid; quantities are integer. The audit
-- ledger malak_audit(action_type, agent, sku, product_id, field, old_value,
-- new_value, details, status) matches insertAuditRow's write shape.
-- ============================================================================

create or replace function public.process_talabat_order_deduction(
  p_order_id   uuid,
  p_dedup_key  text,
  p_plan       jsonb,
  p_resolution jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status     text;
  v_dedup      text;
  v_fail       text := null;
  v_safe       jsonb;
  v_agg        jsonb;
  v_ded        jsonb;
  v_pid        uuid;
  v_vsku       text;
  v_qty        integer;
  v_avail      integer;
  v_shelf_sum  integer;
  v_cnt        integer;
  v_inv_id     uuid;
  v_variant_id uuid;
  v_before     integer;
  v_after      integer;
  v_sum        integer;
  v_rem        integer;
  v_rows       integer;
  r            record;
begin
  -- A non-empty dedup key is mandatory.
  if p_dedup_key is null or length(btrim(p_dedup_key)) = 0 then
    return jsonb_build_object('status', 'error', 'reason', 'missing_dedup_key');
  end if;

  -- Whitelist the resolution up front — arbitrary/raw fields are dropped even if
  -- the caller sent them.
  v_safe := jsonb_strip_nulls(jsonb_build_object(
    'lines',    p_resolution -> 'lines',
    'targets',  p_resolution -> 'targets',
    'lineKeys', p_resolution -> 'lineKeys',
    'reason',   p_resolution -> 'reason',
    'reasons',  p_resolution -> 'reasons',
    'via',      p_resolution -> 'via',
    'method',   p_resolution -> 'method'
  ));

  -- Serialize concurrent calls for the same dedup key BEFORE any inventory lock,
  -- so a duplicate can never race the deduction (no reliance on a unique-index
  -- violation at commit time).
  perform pg_advisory_xact_lock(hashtext(p_dedup_key));

  -- Lock the order row for the rest of the transaction.
  select processing_status, dedup_key into v_status, v_dedup
    from talabat_orders where id = p_order_id for update;
  if not found then
    return jsonb_build_object('status', 'error', 'reason', 'order_not_found');
  end if;

  -- Idempotent: already resolved → no new deduction.
  if v_status in ('processed', 'manual_review') then
    return jsonb_build_object('status', v_status, 'idempotent', true);
  end if;

  -- Duplicate detection (checked BEFORE locking any inventory): this order's key
  -- disagrees with a stored one, or another order already processed this key.
  if v_dedup is not null and v_dedup <> p_dedup_key then
    v_fail := 'duplicate_order';
  elsif exists (select 1 from talabat_orders
                 where dedup_key = p_dedup_key and id <> p_order_id and processing_status = 'processed') then
    v_fail := 'duplicate_order';
  end if;

  -- Validate the plan shape: a non-empty "deductions" array with a uuid product
  -- id and a positive-integer quantity on every row.
  if v_fail is null then
    if p_plan is null or jsonb_typeof(p_plan -> 'deductions') <> 'array'
       or jsonb_array_length(p_plan -> 'deductions') = 0 then
      v_fail := 'invalid_plan';
    else
      for v_ded in select * from jsonb_array_elements(p_plan -> 'deductions') loop
        if (v_ded ->> 'masterProductId') is null or (v_ded ->> 'quantity') !~ '^[1-9][0-9]*$' then
          v_fail := 'invalid_plan'; exit;
        end if;
      end loop;
    end if;
  end if;

  -- Defensive aggregation: sum quantities per (masterProductId, masterVariantSku).
  if v_fail is null then
    select jsonb_agg(jsonb_build_object('masterProductId', pid, 'masterVariantSku', vsku, 'quantity', qsum))
      into v_agg
      from (
        select (d ->> 'masterProductId') as pid,
               (d ->> 'masterVariantSku') as vsku,
               sum((d ->> 'quantity')::int) as qsum
          from jsonb_array_elements(p_plan -> 'deductions') d
         group by 1, 2
      ) g;
  end if;

  -- ---- PASS 1: lock + verify every aggregated target (no writes) -----------
  if v_fail is null then
    for v_ded in select * from jsonb_array_elements(v_agg) loop
      v_pid  := (v_ded ->> 'masterProductId')::uuid;
      v_vsku := v_ded ->> 'masterVariantSku';
      v_qty  := (v_ded ->> 'quantity')::int;
      if v_qty <= 0 then v_fail := 'invalid_plan'; exit; end if;

      if v_vsku is null then
        -- No-variant target: the product must have NO variants, and exactly one
        -- inventory row.
        select count(*) into v_cnt from product_variants where parent_product_id = v_pid;
        if v_cnt <> 0 then v_fail := 'inventory_inconsistent'; exit; end if;
        select count(*) into v_cnt from inventory where product_id = v_pid;
        if v_cnt <> 1 then v_fail := 'inventory_inconsistent'; exit; end if;
        select id, coalesce(stock_quantity, 0) into v_inv_id, v_avail
          from inventory where product_id = v_pid for update;
        perform 1 from shelf_stock where inventory_id = v_inv_id for update;
        if exists (select 1 from shelf_stock where inventory_id = v_inv_id) then
          select coalesce(sum(quantity), 0) into v_shelf_sum from shelf_stock where inventory_id = v_inv_id;
          if v_shelf_sum <> v_avail then v_fail := 'inventory_inconsistent'; exit; end if;
        end if;
        if v_qty > v_avail then v_fail := 'insufficient_stock'; exit; end if;
      else
        -- Variant target: exactly one variant for (parent, sku), and exactly one
        -- parent inventory row.
        select count(*) into v_cnt from product_variants where parent_product_id = v_pid and sku = v_vsku;
        if v_cnt <> 1 then v_fail := 'inventory_inconsistent'; exit; end if;
        select id, coalesce(stock_quantity, 0) into v_variant_id, v_avail
          from product_variants where parent_product_id = v_pid and sku = v_vsku for update;
        select count(*) into v_cnt from inventory where product_id = v_pid;
        if v_cnt <> 1 then v_fail := 'inventory_inconsistent'; exit; end if;
        perform 1 from inventory where product_id = v_pid for update;
        perform 1 from variant_shelf_stock where variant_id = v_variant_id for update;
        if exists (select 1 from variant_shelf_stock where variant_id = v_variant_id) then
          select coalesce(sum(quantity), 0) into v_shelf_sum from variant_shelf_stock where variant_id = v_variant_id;
          if v_shelf_sum <> v_avail then v_fail := 'inventory_inconsistent'; exit; end if;
        end if;
        if v_qty > v_avail then v_fail := 'insufficient_stock'; exit; end if;
      end if;
    end loop;
  end if;

  -- Any failure → manual_review, nothing deducted. Only classified, safe reasons
  -- are stored (never a raw DB error).
  if v_fail is not null then
    update talabat_orders
       set processing_status = 'manual_review', processed_at = now(),
           resolution = v_safe || jsonb_build_object('reason', v_fail)
     where id = p_order_id;
    return jsonb_build_object('status', 'manual_review', 'reason', v_fail);
  end if;

  -- ---- PASS 2: apply everything or nothing (subtransaction) -----------------
  begin
    for v_ded in select * from jsonb_array_elements(v_agg) loop
      v_pid  := (v_ded ->> 'masterProductId')::uuid;
      v_vsku := v_ded ->> 'masterVariantSku';
      v_qty  := (v_ded ->> 'quantity')::int;

      if v_vsku is null then
        select id, coalesce(stock_quantity, 0) into v_inv_id, v_before from inventory where product_id = v_pid;
        v_after := v_before - v_qty;
        if v_after < 0 then raise exception 'talabat_underflow'; end if;   -- verified check, not greatest()
        v_rem := v_qty;
        for r in select id, quantity from shelf_stock where inventory_id = v_inv_id order by quantity desc loop
          exit when v_rem <= 0;
          update shelf_stock set quantity = quantity - least(quantity, v_rem), updated_at = now() where id = r.id;
          v_rem := v_rem - least(r.quantity, v_rem);
        end loop;
        update inventory set stock_quantity = v_after, updated_at = now() where id = v_inv_id;
        get diagnostics v_rows = row_count;
        if v_rows <> 1 then raise exception 'talabat_rowcount'; end if;
        insert into malak_audit (action_type, agent, sku, product_id, field, old_value, new_value, details, status)
        values ('stock_out', 'talabat', null, v_pid, 'stock_quantity', v_before::text, v_after::text,
                jsonb_build_object('source', 'talabat', 'productId', v_pid, 'inventoryId', v_inv_id,
                                   'quantity', v_qty, 'direction', 'out', 'reason', 'talabat_order'), 'done');
      else
        select id, coalesce(stock_quantity, 0) into v_variant_id, v_before
          from product_variants where parent_product_id = v_pid and sku = v_vsku;
        v_after := v_before - v_qty;
        if v_after < 0 then raise exception 'talabat_underflow'; end if;
        v_rem := v_qty;
        for r in select id, quantity from variant_shelf_stock where variant_id = v_variant_id order by quantity desc loop
          exit when v_rem <= 0;
          update variant_shelf_stock set quantity = quantity - least(quantity, v_rem), updated_at = now() where id = r.id;
          v_rem := v_rem - least(r.quantity, v_rem);
        end loop;
        update product_variants set stock_quantity = v_after where id = v_variant_id;
        get diagnostics v_rows = row_count;
        if v_rows <> 1 then raise exception 'talabat_rowcount'; end if;
        -- Rollup: parent inventory = SUM of its variants (never max()).
        select coalesce(sum(coalesce(stock_quantity, 0)), 0) into v_sum
          from product_variants where parent_product_id = v_pid;
        update inventory set stock_quantity = v_sum, updated_at = now() where product_id = v_pid;
        insert into malak_audit (action_type, agent, sku, product_id, field, old_value, new_value, details, status)
        values ('stock_out', 'talabat', v_vsku, v_pid, 'variant_stock_quantity', v_before::text, v_after::text,
                jsonb_build_object('source', 'talabat', 'productId', v_pid, 'variantSku', v_vsku, 'variantId', v_variant_id,
                                   'quantity', v_qty, 'direction', 'out', 'reason', 'talabat_order'), 'done');
      end if;
    end loop;
  exception when others then
    -- The subtransaction rolled back every PASS-2 write. Park the order for
    -- manual review with a classified reason — never the raw error / SQLERRM.
    update talabat_orders
       set processing_status = 'manual_review', processed_at = now(),
           resolution = v_safe || jsonb_build_object('reason', 'inventory_inconsistent')
     where id = p_order_id;
    return jsonb_build_object('status', 'manual_review', 'reason', 'inventory_inconsistent');
  end;

  update talabat_orders
     set processing_status = 'processed', processed_at = now(),
         dedup_key = coalesce(dedup_key, p_dedup_key),
         resolution = v_safe
   where id = p_order_id;

  return jsonb_build_object('status', 'processed');
end;
$$;

-- Server / service-role only. The browser (anon, authenticated) can NEVER call
-- the deduction directly.
revoke all on function public.process_talabat_order_deduction(uuid, text, jsonb, jsonb) from public;
revoke all on function public.process_talabat_order_deduction(uuid, text, jsonb, jsonb) from anon;
revoke all on function public.process_talabat_order_deduction(uuid, text, jsonb, jsonb) from authenticated;
grant execute on function public.process_talabat_order_deduction(uuid, text, jsonb, jsonb) to service_role;
