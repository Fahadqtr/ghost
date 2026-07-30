-- ============================================================================
-- process_talabat_order_deduction — atomic, all-or-nothing Talabat order
-- deduction. Run ONCE in the Supabase SQL editor of the PRODUCTION project
-- (vqstcmattiarhblqshvb). Idempotent (create or replace + guarded grants).
--
-- The whole body runs in ONE transaction: it locks the order row and every
-- targeted inventory / variant / shelf row FOR UPDATE, verifies quantities and
-- stock, then either deducts EVERYTHING or nothing. It records each movement in
-- `malak_audit` (this project's stock-movement ledger — there is no separate
-- stock_movements table) and rolls the parent inventory up to the SUM of its
-- variants (never max(parent, variants)). It never writes a negative quantity
-- and never adds a per-channel stock column.
--
-- Idempotency: an order already 'processed' or 'manual_review' returns its
-- current state with no new deduction. A dedup_key that disagrees with the
-- stored one is treated as a duplicate and parked for manual review.
--
-- Column types verified against the live schema: talabat_orders.id / products.id
-- / inventory.id / inventory.product_id / product_variants.id /
-- product_variants.parent_product_id are uuid; shelf_stock.inventory_id and
-- variant_shelf_stock.variant_id are uuid; quantities are integer.
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
  v_ded        jsonb;
  v_pid        uuid;
  v_vsku       text;
  v_qty        integer;
  v_avail      integer;
  v_shelf_sum  integer;
  v_inv_id     uuid;
  v_variant_id uuid;
  v_before     integer;
  v_after      integer;
  v_sum        integer;
  v_rem        integer;
  r            record;
begin
  -- Lock the order row for the duration of the transaction.
  select processing_status, dedup_key into v_status, v_dedup
    from talabat_orders where id = p_order_id for update;
  if not found then
    return jsonb_build_object('status', 'error', 'reason', 'order_not_found');
  end if;

  -- Idempotent: already resolved → no new deduction.
  if v_status in ('processed', 'manual_review') then
    return jsonb_build_object('status', v_status, 'idempotent', true);
  end if;

  -- Dedup key must agree with the order (a disagreement is a duplicate).
  if v_dedup is not null and v_dedup <> p_dedup_key then
    update talabat_orders
       set processing_status = 'manual_review', processed_at = now(),
           resolution = coalesce(p_resolution, '{}'::jsonb) || jsonb_build_object('reason', 'duplicate_order')
     where id = p_order_id;
    return jsonb_build_object('status', 'manual_review', 'reason', 'duplicate_order');
  end if;

  -- ---- PASS 1: lock + verify every target (no writes) ----------------------
  for v_ded in select * from jsonb_array_elements(coalesce(p_plan -> 'deductions', '[]'::jsonb)) loop
    v_pid  := (v_ded ->> 'masterProductId')::uuid;
    v_vsku := v_ded ->> 'masterVariantSku';
    v_qty  := coalesce((v_ded ->> 'quantity')::int, 0);

    if v_qty <= 0 then v_fail := 'invalid_quantity'; exit; end if;

    if v_vsku is null then
      -- No-variant product: lock its inventory row.
      select id, coalesce(stock_quantity, 0) into v_inv_id, v_avail
        from inventory where product_id = v_pid for update;
      if not found then v_fail := 'inventory_inconsistent'; exit; end if;
      -- Lock shelf rows, then check they reconcile with the headline stock.
      perform 1 from shelf_stock where inventory_id = v_inv_id for update;
      if exists (select 1 from shelf_stock where inventory_id = v_inv_id) then
        select coalesce(sum(quantity), 0) into v_shelf_sum from shelf_stock where inventory_id = v_inv_id;
        if v_shelf_sum <> v_avail then v_fail := 'inventory_inconsistent'; exit; end if;
      end if;
      if v_qty > v_avail then v_fail := 'insufficient_stock'; exit; end if;
    else
      -- Variant: lock the variant row (durable identity = parent + SKU).
      select id, coalesce(stock_quantity, 0) into v_variant_id, v_avail
        from product_variants where parent_product_id = v_pid and sku = v_vsku for update;
      if not found then v_fail := 'inventory_inconsistent'; exit; end if;
      perform 1 from variant_shelf_stock where variant_id = v_variant_id for update;
      if exists (select 1 from variant_shelf_stock where variant_id = v_variant_id) then
        select coalesce(sum(quantity), 0) into v_shelf_sum from variant_shelf_stock where variant_id = v_variant_id;
        if v_shelf_sum <> v_avail then v_fail := 'inventory_inconsistent'; exit; end if;
      end if;
      if v_qty > v_avail then v_fail := 'insufficient_stock'; exit; end if;
      -- Lock the parent inventory row (rollup target).
      perform 1 from inventory where product_id = v_pid for update;
    end if;
  end loop;

  -- Any failure → manual_review, nothing deducted. Only classified, safe
  -- reasons are stored (never a raw DB error).
  if v_fail is not null then
    update talabat_orders
       set processing_status = 'manual_review', processed_at = now(),
           resolution = coalesce(p_resolution, '{}'::jsonb) || jsonb_build_object('reason', v_fail)
     where id = p_order_id;
    return jsonb_build_object('status', 'manual_review', 'reason', v_fail);
  end if;

  -- ---- PASS 2: apply (every target already verified) -----------------------
  for v_ded in select * from jsonb_array_elements(coalesce(p_plan -> 'deductions', '[]'::jsonb)) loop
    v_pid  := (v_ded ->> 'masterProductId')::uuid;
    v_vsku := v_ded ->> 'masterVariantSku';
    v_qty  := coalesce((v_ded ->> 'quantity')::int, 0);

    if v_vsku is null then
      select id, coalesce(stock_quantity, 0) into v_inv_id, v_before from inventory where product_id = v_pid;
      v_after := greatest(v_before - v_qty, 0);
      -- Spread across shelves, biggest first, never below zero.
      v_rem := v_qty;
      for r in select id, quantity from shelf_stock where inventory_id = v_inv_id order by quantity desc loop
        exit when v_rem <= 0;
        update shelf_stock set quantity = greatest(quantity - least(quantity, v_rem), 0), updated_at = now() where id = r.id;
        v_rem := v_rem - least(r.quantity, v_rem);
      end loop;
      update inventory set stock_quantity = v_after, updated_at = now() where id = v_inv_id;
      insert into malak_audit (action_type, agent, sku, product_id, field, old_value, new_value, details, status)
      values ('stock_out', 'talabat', null, v_pid, 'stock_quantity', v_before::text, v_after::text,
              jsonb_build_object('source', 'talabat', 'productId', v_pid, 'inventoryId', v_inv_id,
                                 'quantity', v_qty, 'direction', 'out', 'reason', 'talabat_order'), 'done');
    else
      select id, coalesce(stock_quantity, 0) into v_variant_id, v_before
        from product_variants where parent_product_id = v_pid and sku = v_vsku;
      v_after := greatest(v_before - v_qty, 0);
      v_rem := v_qty;
      for r in select id, quantity from variant_shelf_stock where variant_id = v_variant_id order by quantity desc loop
        exit when v_rem <= 0;
        update variant_shelf_stock set quantity = greatest(quantity - least(quantity, v_rem), 0), updated_at = now() where id = r.id;
        v_rem := v_rem - least(r.quantity, v_rem);
      end loop;
      update product_variants set stock_quantity = v_after where id = v_variant_id;
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

  update talabat_orders
     set processing_status = 'processed', processed_at = now(),
         dedup_key = coalesce(dedup_key, p_dedup_key),
         resolution = coalesce(p_resolution, '{}'::jsonb)
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
