-- Phase 2A.4 (hardening) — TRANSACTIONAL Shopify POS order deduction.
--
-- ADDITIVE & idempotent. Run ONCE in the production SQL editor. It:
--   1) adds ledger status columns to the existing shopify_synced_orders table
--      (no drop, no recreate, no data loss — existing rows keep working); and
--   2) creates a Shopify-specific SECURITY DEFINER function that performs, inside
--      a SINGLE transaction: the idempotency claim (order_id PK) + ALL inventory
--      deductions for the order + the ledger completion. Any error rolls back the
--      claim AND every stock change together, so there is no "recorded but not
--      deducted" (or vice-versa) partial state.
--
-- It does NOT touch any Talabat table/function and does NOT reuse or modify
-- process_talabat_order_deduction. It changes no deduction quantities and no
-- SKU/title matching (matching happens in TypeScript; this only spreads/clamps
-- the already-decided per-product quantity across the product's inventory rows,
-- exactly like the old spreadDeduction: biggest row first, never below zero).
--
-- Type note: products.id / inventory.id / inventory.product_id are UUID. The
-- function validates each p_deductions product_id as a UUID string BEFORE casting
-- and compares uuid = uuid (never uuid = text). p_order_id stays text (it is the
-- Shopify Order GID, e.g. 'gid://shopify/Order/123').

-- ── 1) Additive ledger status columns ──────────────────────────────────────
alter table public.shopify_synced_orders
  add column if not exists processing_status text not null default 'completed';
alter table public.shopify_synced_orders
  add column if not exists processed_at timestamptz;
alter table public.shopify_synced_orders
  add column if not exists deduction_result jsonb;

-- ── 2) Atomic claim + deduct + complete ────────────────────────────────────
-- Returns jsonb: {status, deducted, products}. status ∈
--   'processed'         — recorded now and stock deducted (deducted = rows written)
--   'already_processed' — order_id already in the ledger; NOTHING deducted
--   'baseline_recorded' — first-run baseline; recorded, NOTHING deducted
create or replace function public.process_shopify_order_deduction(
  p_order_id             text,
  p_order_name           text,
  p_channel              text,
  p_payment_gateway_names jsonb,
  p_deductions           jsonb,   -- [{ "product_id": "<uuid>", "quantity": 1 }, ...]
  p_baseline             boolean
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deducted  int := 0;
  v_products  jsonb := '[]'::jsonb;
  v_item      jsonb;
  v_pid_text  text;
  v_qty_num   numeric;
  v_agg       record;
  v_remaining int;
  v_before    int;
  v_take      int;
  v_row       record;
begin
  if p_order_id is null or length(p_order_id) = 0 then
    raise exception 'p_order_id is required';
  end if;
  if jsonb_typeof(coalesce(p_deductions, '[]'::jsonb)) <> 'array' then
    raise exception 'p_deductions must be a json array';
  end if;

  -- CLAIM. Insert the ledger row first. ON CONFLICT DO NOTHING + the FOUND check
  -- is the sole concurrency arbiter: exactly one caller can win a given order_id,
  -- so a concurrent duplicate (or a re-run) can never deduct the same order twice.
  insert into public.shopify_synced_orders
    (order_id, order_name, deducted, channel, payment_gateway_names, processing_status, processed_at)
  values
    (p_order_id, p_order_name, 0, coalesce(nullif(p_channel, ''), 'shopify'), p_payment_gateway_names, 'pending', now())
  on conflict (order_id) do nothing;

  if not found then
    return jsonb_build_object('status', 'already_processed', 'deducted', 0);
  end if;

  -- BASELINE first run: record only, deduct nothing.
  if coalesce(p_baseline, false) then
    update public.shopify_synced_orders
      set processing_status = 'completed', processed_at = now(),
          deduction_result = jsonb_build_object('status', 'baseline_recorded', 'deducted', 0)
      where order_id = p_order_id;
    return jsonb_build_object('status', 'baseline_recorded', 'deducted', 0);
  end if;

  -- VALIDATE every deduction element BEFORE any cast or write. Any malformed input
  -- raises, which rolls back the claim (and everything else). No cast happens until
  -- the UUID format is confirmed, so an invalid product_id never reaches ::uuid.
  for v_item in
    select value from jsonb_array_elements(coalesce(p_deductions, '[]'::jsonb)) as t(value)
  loop
    if jsonb_typeof(v_item) <> 'object' then
      raise exception 'each deduction must be a json object';
    end if;
    v_pid_text := v_item->>'product_id';
    if v_pid_text is null
       or v_pid_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'invalid product_id (not a uuid)';
    end if;
    if jsonb_typeof(v_item->'quantity') <> 'number' then
      raise exception 'quantity must be a json number';
    end if;
    v_qty_num := (v_item->>'quantity')::numeric;
    if v_qty_num <= 0 or v_qty_num <> floor(v_qty_num) or v_qty_num > 2147483647 then
      raise exception 'quantity must be a positive int4';
    end if;
  end loop;

  -- AGGREGATE duplicate product_ids, then DEDUCT. Products are handled in a
  -- deterministic order (product_id) and each product's rows are locked FOR UPDATE
  -- in a deterministic order (id) BEFORE any write — so two concurrent orders
  -- touching the same products acquire row locks in the same global order and
  -- cannot deadlock. Deduction is biggest-row-first, clamped at zero.
  for v_agg in
    select (value->>'product_id')::uuid as pid,
           sum(floor((value->>'quantity')::numeric)::int)::int as qty
    from jsonb_array_elements(p_deductions) as t(value)
    group by (value->>'product_id')::uuid
    order by (value->>'product_id')::uuid
  loop
    v_before := 0;
    for v_row in
      select id, coalesce(stock_quantity, 0) as stock
      from public.inventory
      where product_id = v_agg.pid   -- uuid = uuid
      order by id
      for update
    loop
      v_before := v_before + v_row.stock;
    end loop;

    v_remaining := v_agg.qty;
    for v_row in
      select id, coalesce(stock_quantity, 0) as stock
      from public.inventory
      where product_id = v_agg.pid   -- uuid = uuid
      order by coalesce(stock_quantity, 0) desc, id
    loop
      exit when v_remaining <= 0;
      if v_row.stock <= 0 then continue; end if;
      v_take := least(v_row.stock, v_remaining);
      update public.inventory set stock_quantity = v_row.stock - v_take where id = v_row.id;
      v_remaining := v_remaining - v_take;
      v_deducted := v_deducted + 1;
    end loop;

    v_products := v_products || jsonb_build_object(
      'product_id', v_agg.pid, 'before', v_before, 'after', v_before - (v_agg.qty - v_remaining));
  end loop;

  -- COMPLETE the ledger row in the SAME transaction. If anything above raised,
  -- this update (and the claim, and every deduction) is rolled back together.
  update public.shopify_synced_orders
    set deducted = v_deducted, processing_status = 'completed', processed_at = now(),
        deduction_result = jsonb_build_object('status', 'processed', 'deducted', v_deducted, 'products', v_products)
    where order_id = p_order_id;

  return jsonb_build_object('status', 'processed', 'deducted', v_deducted, 'products', v_products);
end;
$$;

-- ── 3) Least privilege ─────────────────────────────────────────────────────
-- Only the service role (used by the cron and the server action) may execute it.
revoke all on function public.process_shopify_order_deduction(text, text, text, jsonb, jsonb, boolean) from public;
revoke all on function public.process_shopify_order_deduction(text, text, text, jsonb, jsonb, boolean) from anon;
revoke all on function public.process_shopify_order_deduction(text, text, text, jsonb, jsonb, boolean) from authenticated;
grant execute on function public.process_shopify_order_deduction(text, text, text, jsonb, jsonb, boolean) to service_role;
