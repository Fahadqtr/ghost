-- ============================================================================
-- process_talabat_order_deduction — atomic, all-or-nothing Talabat order
-- deduction. Run ONCE in the Supabase SQL editor of the PRODUCTION project
-- (vqstcmattiarhblqshvb). Idempotent (create or replace + guarded grants).
--
-- The whole body runs in ONE transaction. It takes a per-dedup-key advisory
-- lock FIRST, then locks the order row FOR UPDATE. A non-empty dedup key is
-- mandatory. An already-resolved order returns idempotently only when its stored
-- key matches; ANY other order holding this key (regardless of its status —
-- pending / processed / manual_review / failed) blocks the deduction as a
-- duplicate_order; the key is then reserved on THIS order (row-count checked) so
-- no late unique violation can surface. The plan is STRICTLY validated (JSON
-- object, status='ready', non-empty deductions, UUID masterProductId, null-or-
-- non-empty masterVariantSku, quantity a JSON number that is a positive integer
-- within int4 range — the string "2" is rejected) before any cast runs, so a
-- malformed plan deterministically becomes invalid_plan and can never raise a raw
-- cast error. Quantities are aggregated per target in BIGINT and an overflow past
-- int4 range is rejected. It verifies stock and inventory invariants (PASS 1, no
-- writes; NULL/negative stock or negative shelf quantity → inventory_inconsistent
-- rather than a silent coalesce-to-0), then applies everything or nothing (PASS 2,
-- in a subtransaction; EVERY critical UPDATE — shelf, inventory, variant, rollup,
-- final order — checks GET DIAGNOSTICS ROW_COUNT = 1, and the shelf spread must
-- place the whole quantity (v_rem = 0) or the apply rolls back). It records each
-- movement in `malak_audit` (this project's stock-movement ledger — there is NO
-- stock_movements table), rolls the parent inventory up to the SUM of its
-- variants (never max(parent, variants)), never writes a negative quantity, and
-- never adds a per-channel stock column.
--
-- Only a DEEP-whitelisted, non-personal projection of the resolution is stored:
-- lines/targets/reasons are rebuilt element-by-element (never copied through), so
-- a token / phone / address / raw payload / header / DB error nested at any level
-- is dropped.
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
  v_lines      jsonb;
  v_targets    jsonb;
  v_reasons    jsonb;
  v_agg        jsonb;
  v_ded        jsonb;
  v_msku       jsonb;
  v_pid        uuid;
  v_vsku       text;
  v_qty        integer;
  v_avail      integer;
  v_avail_raw  integer;
  v_shelf_sum  integer;
  v_cnt        integer;
  v_inv_id     uuid;
  v_variant_id uuid;
  v_before     integer;
  v_after      integer;
  v_sum        integer;
  v_rem        integer;
  v_rows       integer;
  v_uuid_re    text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  r            record;
begin
  -- A non-empty dedup key is mandatory.
  if p_dedup_key is null or length(btrim(p_dedup_key)) = 0 then
    return jsonb_build_object('status', 'error', 'reason', 'missing_dedup_key');
  end if;

  -- DEEP whitelist of the resolution — arbitrary/raw fields are dropped even if
  -- nested inside lines/targets/reasons. Each collection is rebuilt element-by-
  -- element (never `p_resolution -> 'lines'`/`'targets'` copied through), so a
  -- token / phone / address / raw payload nested one level down cannot survive.
  select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'lineKey',  e -> 'lineKey',
           'status',   e -> 'status',
           'via',      e -> 'via',
           'reason',   e -> 'reason',
           'quantity', e -> 'quantity',
           'target',   case when jsonb_typeof(e -> 'target') = 'object'
                            then jsonb_strip_nulls(jsonb_build_object(
                                   'masterProductId',  e #> '{target,masterProductId}',
                                   'masterVariantSku', e #> '{target,masterVariantSku}'))
                            else null end)))
    into v_lines
    from jsonb_array_elements(case when jsonb_typeof(p_resolution -> 'lines') = 'array' then p_resolution -> 'lines' else '[]'::jsonb end) e;

  select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'masterProductId',  e -> 'masterProductId',
           'masterVariantSku', e -> 'masterVariantSku',
           'quantity',         e -> 'quantity',
           'lineKeys',         (select jsonb_agg(y) from jsonb_array_elements(
                                  case when jsonb_typeof(e -> 'lineKeys') = 'array' then e -> 'lineKeys' else '[]'::jsonb end) y
                                 where jsonb_typeof(y) = 'string'))))
    into v_targets
    from jsonb_array_elements(case when jsonb_typeof(p_resolution -> 'targets') = 'array' then p_resolution -> 'targets' else '[]'::jsonb end) e;

  select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'lineKey', e -> 'lineKey',
           'reason',  e -> 'reason')))
    into v_reasons
    from jsonb_array_elements(case when jsonb_typeof(p_resolution -> 'reasons') = 'array' then p_resolution -> 'reasons' else '[]'::jsonb end) e;

  v_safe := jsonb_strip_nulls(jsonb_build_object(
    'lines',    v_lines,
    'targets',  v_targets,
    'reasons',  v_reasons,
    'lineKeys', (select jsonb_agg(y) from jsonb_array_elements(
                   case when jsonb_typeof(p_resolution -> 'lineKeys') = 'array' then p_resolution -> 'lineKeys' else '[]'::jsonb end) y
                  where jsonb_typeof(y) = 'string'),
    'reason',   case when jsonb_typeof(p_resolution -> 'reason') in ('string', 'number') then p_resolution -> 'reason' else null end,
    'via',      case when jsonb_typeof(p_resolution -> 'via')    in ('string', 'number') then p_resolution -> 'via'    else null end,
    'method',   case when jsonb_typeof(p_resolution -> 'method') in ('string', 'number') then p_resolution -> 'method' else null end
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

  -- Idempotent: already resolved. Its stored key must match — a different key on
  -- an already-processed order is a duplicate, returned WITHOUT touching its
  -- stock or status.
  if v_status in ('processed', 'manual_review') then
    if v_dedup is not null and v_dedup <> p_dedup_key then
      return jsonb_build_object('status', 'duplicate_order', 'idempotent', true);
    end if;
    return jsonb_build_object('status', v_status, 'idempotent', true);
  end if;

  -- Duplicate detection (checked BEFORE locking any inventory): this order's key
  -- disagrees with a stored one, OR ANY OTHER order already holds this key —
  -- regardless of that order's status (pending / processed / manual_review /
  -- failed). We do NOT restrict to processing_status = 'processed'.
  if v_dedup is not null and v_dedup <> p_dedup_key then
    v_fail := 'duplicate_order';
  elsif exists (select 1 from talabat_orders
                 where dedup_key = p_dedup_key and id <> p_order_id) then
    v_fail := 'duplicate_order';
  end if;

  -- Reserve the key on THIS order before locking any inventory, so a late unique
  -- violation can never surface after the deduction. Exactly one row must change.
  if v_fail is null then
    update talabat_orders set dedup_key = p_dedup_key
     where id = p_order_id and (dedup_key is null or dedup_key = p_dedup_key);
    get diagnostics v_rows = row_count;
    if v_rows <> 1 then v_fail := 'duplicate_order'; end if;
  end if;

  -- STRICT plan-shape validation (BEFORE any inventory lock). Every check is a
  -- type/format test — no `::uuid` / `::int` cast runs until the value is proven
  -- valid — so a malformed plan can NEVER raise a raw PostgreSQL cast error; it
  -- deterministically becomes invalid_plan → manual_review.
  --   * p_plan is a JSON object
  --   * p_plan.status = 'ready'
  --   * p_plan.deductions is a non-empty array
  --   * masterProductId is a valid UUID string
  --   * masterVariantSku is JSON null or a non-empty string
  --   * quantity is a JSON *number*, a positive integer, within int4 range
  --     (the string "2" is rejected)
  if v_fail is null then
    if p_plan is null or jsonb_typeof(p_plan) <> 'object'
       or (p_plan ->> 'status') is distinct from 'ready'
       or jsonb_typeof(p_plan -> 'deductions') <> 'array'
       or jsonb_array_length(p_plan -> 'deductions') = 0 then
      v_fail := 'invalid_plan';
    else
      for v_ded in select * from jsonb_array_elements(p_plan -> 'deductions') loop
        v_msku := v_ded -> 'masterVariantSku';
        if (v_ded ->> 'masterProductId') is null
           or (v_ded ->> 'masterProductId') !~ v_uuid_re
           or not (jsonb_typeof(v_msku) = 'null'
                   or (jsonb_typeof(v_msku) = 'string' and length(v_ded ->> 'masterVariantSku') > 0))
           or jsonb_typeof(v_ded -> 'quantity') <> 'number'
           or (v_ded ->> 'quantity') !~ '^[1-9][0-9]*$'
           or (v_ded ->> 'quantity')::numeric > 2147483647 then
          v_fail := 'invalid_plan'; exit;
        end if;
      end loop;
    end if;
  end if;

  -- Defensive aggregation: sum quantities per (masterProductId, masterVariantSku)
  -- in BIGINT, then reject any aggregated total that overflows int4 range.
  if v_fail is null then
    if exists (
      select 1 from (
        select sum((d ->> 'quantity')::bigint) as qsum
          from jsonb_array_elements(p_plan -> 'deductions') d
         group by (d ->> 'masterProductId'), (d ->> 'masterVariantSku')
      ) s where s.qsum > 2147483647
    ) then
      v_fail := 'invalid_plan';
    else
      select jsonb_agg(jsonb_build_object('masterProductId', pid, 'masterVariantSku', vsku, 'quantity', qsum))
        into v_agg
        from (
          select (d ->> 'masterProductId') as pid,
                 (d ->> 'masterVariantSku') as vsku,
                 sum((d ->> 'quantity')::bigint) as qsum
            from jsonb_array_elements(p_plan -> 'deductions') d
           group by 1, 2
        ) g;
    end if;
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
        select id, stock_quantity into v_inv_id, v_avail_raw
          from inventory where product_id = v_pid for update;
        -- NULL is NOT silently coalesced to 0: an unexpected NULL or a negative
        -- stock is treated as an inconsistency, never a valid zero.
        if v_avail_raw is null or v_avail_raw < 0 then v_fail := 'inventory_inconsistent'; exit; end if;
        v_avail := v_avail_raw;
        perform 1 from shelf_stock where inventory_id = v_inv_id for update;
        if exists (select 1 from shelf_stock where inventory_id = v_inv_id) then
          if exists (select 1 from shelf_stock where inventory_id = v_inv_id and (quantity is null or quantity < 0)) then
            v_fail := 'inventory_inconsistent'; exit;
          end if;
          select coalesce(sum(quantity), 0) into v_shelf_sum from shelf_stock where inventory_id = v_inv_id;
          if v_shelf_sum <> v_avail then v_fail := 'inventory_inconsistent'; exit; end if;
        end if;
        if v_qty > v_avail then v_fail := 'insufficient_stock'; exit; end if;
      else
        -- Variant target: exactly one variant for (parent, sku), and exactly one
        -- parent inventory row.
        select count(*) into v_cnt from product_variants where parent_product_id = v_pid and sku = v_vsku;
        if v_cnt <> 1 then v_fail := 'inventory_inconsistent'; exit; end if;
        select id, stock_quantity into v_variant_id, v_avail_raw
          from product_variants where parent_product_id = v_pid and sku = v_vsku for update;
        if v_avail_raw is null or v_avail_raw < 0 then v_fail := 'inventory_inconsistent'; exit; end if;
        v_avail := v_avail_raw;
        -- Exactly one parent inventory row must exist for the rollup target.
        select count(*) into v_cnt from inventory where product_id = v_pid;
        if v_cnt <> 1 then v_fail := 'inventory_inconsistent'; exit; end if;
        perform 1 from inventory where product_id = v_pid for update;
        perform 1 from variant_shelf_stock where variant_id = v_variant_id for update;
        if exists (select 1 from variant_shelf_stock where variant_id = v_variant_id) then
          if exists (select 1 from variant_shelf_stock where variant_id = v_variant_id and (quantity is null or quantity < 0)) then
            v_fail := 'inventory_inconsistent'; exit;
          end if;
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
        -- Shelf spread only when shelf rows exist; every shelf UPDATE affects
        -- exactly one row, and the whole quantity MUST be placed (v_rem = 0).
        if exists (select 1 from shelf_stock where inventory_id = v_inv_id) then
          v_rem := v_qty;
          for r in select id, quantity from shelf_stock where inventory_id = v_inv_id order by quantity desc loop
            exit when v_rem <= 0;
            update shelf_stock set quantity = quantity - least(quantity, v_rem), updated_at = now() where id = r.id;
            get diagnostics v_rows = row_count;
            if v_rows <> 1 then raise exception 'talabat_rowcount'; end if;
            v_rem := v_rem - least(r.quantity, v_rem);
          end loop;
          if v_rem <> 0 then raise exception 'talabat_shelf_remainder'; end if;
        end if;
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
        if exists (select 1 from variant_shelf_stock where variant_id = v_variant_id) then
          v_rem := v_qty;
          for r in select id, quantity from variant_shelf_stock where variant_id = v_variant_id order by quantity desc loop
            exit when v_rem <= 0;
            update variant_shelf_stock set quantity = quantity - least(quantity, v_rem), updated_at = now() where id = r.id;
            get diagnostics v_rows = row_count;
            if v_rows <> 1 then raise exception 'talabat_rowcount'; end if;
            v_rem := v_rem - least(r.quantity, v_rem);
          end loop;
          if v_rem <> 0 then raise exception 'talabat_shelf_remainder'; end if;
        end if;
        update product_variants set stock_quantity = v_after where id = v_variant_id;
        get diagnostics v_rows = row_count;
        if v_rows <> 1 then raise exception 'talabat_rowcount'; end if;
        -- Rollup: parent inventory = SUM of its variants (never max()). Exactly
        -- one inventory row must change.
        select coalesce(sum(coalesce(stock_quantity, 0)), 0) into v_sum
          from product_variants where parent_product_id = v_pid;
        update inventory set stock_quantity = v_sum, updated_at = now() where product_id = v_pid;
        get diagnostics v_rows = row_count;
        if v_rows <> 1 then raise exception 'talabat_rowcount'; end if;
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
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then raise exception 'talabat_rowcount'; end if;

  return jsonb_build_object('status', 'processed');
end;
$$;

-- Server / service-role only. The browser (anon, authenticated) can NEVER call
-- the deduction directly.
revoke all on function public.process_talabat_order_deduction(uuid, text, jsonb, jsonb) from public;
revoke all on function public.process_talabat_order_deduction(uuid, text, jsonb, jsonb) from anon;
revoke all on function public.process_talabat_order_deduction(uuid, text, jsonb, jsonb) from authenticated;
grant execute on function public.process_talabat_order_deduction(uuid, text, jsonb, jsonb) to service_role;
