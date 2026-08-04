-- Order Operations data-source remediation (Phase 2B.3C).
--
-- shopify_synced_orders has RLS enabled but no SELECT policy, so the signed-in
-- (authenticated) app role reads zero rows and the /order-operations console
-- shows an empty Shopify ledger even when rows exist (they are written by the
-- SECURITY DEFINER RPC process_shopify_order_deduction, which bypasses RLS).
--
-- This migration is additive and idempotent: it (re)asserts RLS and (re)creates
-- ONLY a SELECT policy for the authenticated role. It grants no write, no anon
-- access, uses no service role, and touches no other policy or row. Mirrors the
-- existing talabat_orders_select policy in talabat_orders.sql.

alter table public.shopify_synced_orders enable row level security;

drop policy if exists shopify_synced_orders_select on public.shopify_synced_orders;
create policy shopify_synced_orders_select on public.shopify_synced_orders
  for select to authenticated using (true);
