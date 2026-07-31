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
  p_deductions           jsonb,   -- [{ "product_id": "...", "quantity": 1 }, ...]
  p_baseline             boolean
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deducted int := 0;
  v_products jsonb := '[]'::jsonb;
  v_item     jsonb;
  v_pid      text;
  v_qty      int;
  v_remaining int;
  v_before   int;
  v_take     int;
  v_row      record;
begin
  if p_order_id is null or length(p_order_id) = 0 then
    raise exception 'p_order_id is required';
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

  -- DEDUCT. Products are processed in a deterministic order (product_id), and each
  -- product's rows are locked FOR UPDATE in a deterministic order (id) BEFORE any
  -- write — so two concurrent orders touching the same products acquire row locks
  -- in the same global order and cannot deadlock. Deduction is then applied
  -- biggest-row-first and clamped at zero (the current spreadDeduction logic).
  for v_item in
    select value from jsonb_array_elements(coalesce(p_deductions, '[]'::jsonb)) as t(value)
    order by (value->>'product_id')
  loop
    v_pid := v_item->>'product_id';
    v_qty := greatest(0, floor(coalesce((v_item->>'quantity')::numeric, 0))::int);
    if v_pid is null or v_qty = 0 then continue; end if;

    -- Lock all rows for this product (deterministic id order) and total the stock.
    v_before := 0;
    for v_row in
      select id, coalesce(stock_quantity, 0) as stock
      from public.inventory
      where product_id = v_pid
      order by id
      for update
    loop
      v_before := v_before + v_row.stock;
    end loop;

    -- Apply biggest-first across the now-locked rows.
    v_remaining := v_qty;
    for v_row in
      select id, coalesce(stock_quantity, 0) as stock
      from public.inventory
      where product_id = v_pid
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
      'product_id', v_pid, 'before', v_before, 'after', v_before - (v_qty - v_remaining));
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

-- Manual rollback test (run in a throwaway transaction; DO NOT commit):
--   begin;
--   -- force an error mid-way by passing a bogus quantity type, or add a
--   -- `raise exception` before COMPLETE, then confirm neither the ledger row
--   -- nor any inventory change is visible:
--   select public.process_shopify_order_deduction('gid://x','#x','shopify','[]'::jsonb,
--            '[{"product_id":"p1","quantity":1}]'::jsonb, false);
--   rollback;
