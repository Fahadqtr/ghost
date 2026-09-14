-- DOWN migration for 20260914000000_acc02a_customer_order_expense_readonly.sql
-- (manual).
--
-- Restores the EXACT pre-change state of customers, orders and expenses as read
-- from production immediately before the up migration ran:
--
--   relacl (all three)  postgres=arwdDxtm/postgres  anon=arwdDxtm/postgres
--                       authenticated=arwdDxtm/postgres
--                       service_role=arwdDxtm/postgres
--   policy (all three)  authenticated_all_<table>
--                       FOR ALL TO authenticated USING (true) WITH CHECK (true)
--
-- Running this restores unrestricted Data API write access to customer, order
-- and expense data for every signed-in account, and restores anon's dormant
-- grants. It exists so the change is reversible, not because reverting is
-- advisable. No rows are touched either way, so the rollback is lossless.

-- ── customers ───────────────────────────────────────────────────────────────
drop policy if exists "customers_select_authenticated" on public.customers;
create policy "authenticated_all_customers"
  on public.customers for all to authenticated using (true) with check (true);
grant select, insert, update, delete, truncate, references, trigger
  on public.customers to anon, authenticated;

-- ── orders ──────────────────────────────────────────────────────────────────
drop policy if exists "orders_select_authenticated" on public.orders;
create policy "authenticated_all_orders"
  on public.orders for all to authenticated using (true) with check (true);
grant select, insert, update, delete, truncate, references, trigger
  on public.orders to anon, authenticated;

-- ── expenses ────────────────────────────────────────────────────────────────
drop policy if exists "expenses_select_authenticated" on public.expenses;
create policy "authenticated_all_expenses"
  on public.expenses for all to authenticated using (true) with check (true);
grant select, insert, update, delete, truncate, references, trigger
  on public.expenses to anon, authenticated;
