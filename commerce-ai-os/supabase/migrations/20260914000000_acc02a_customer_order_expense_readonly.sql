-- ACC-02A — remove direct client write access from the three high-sensitivity
-- data tables: customers, orders, expenses.
--
-- WHAT WAS WRONG
-- Each table carried Supabase's default blanket schema grants (arwdDxtm to both
-- anon and authenticated) AND a permissive policy
--   FOR ALL TO authenticated USING (true) WITH CHECK (true)
-- so any account holding a valid session could INSERT, UPDATE or DELETE every
-- row directly through the Data API, without passing through the application's
-- requireOwner / requireMalakWriter gates. Those gates exist only in TypeScript;
-- Postgres sees one interactive identity, `authenticated`.
--
-- anon's grants were inert only because no policy targeted anon - the entire
-- protection was "no policy mentions anon". Revoking the grants removes that
-- single point of failure.
--
-- WHY THESE THREE FIRST
-- They are the highest-sensitivity schemas in the exposed set
--   customers  name, phone, email
--   orders     channel_id, customer_id, total, status
--   expenses   category, amount, note, spent_at
-- and all three are currently EMPTY (0 rows), with no application reader or
-- writer anywhere in app/, lib/ or components/, no database function, view,
-- trigger or inbound foreign key. So the change is free today and closes the
-- hole before any data lands. (The CRM feature reads Shopify's API and the
-- separate crm_customers table via the service role - not these tables.)
--
-- WHAT THIS DOES
-- anon          -> no privileges at all
-- authenticated -> SELECT only; INSERT/UPDATE/DELETE revoked, and the ALL
--                  policy replaced with a SELECT-only policy so a future
--                  re-grant cannot silently restore write access
-- service_role  -> untouched; all server-side workflows keep working
--
-- SELECT is deliberately retained for authenticated rather than removed: no
-- reader exists today, but whether staff may read customer PII is an open owner
-- decision (D-2), and retaining SELECT leaves that decision open instead of
-- pre-empting it. It can be revoked later in one statement if the answer is no.
--
-- SCOPE: public.customers, public.orders, public.expenses ONLY. No other table,
-- no schema/column/index/constraint/trigger change, no rows touched. ACC-02B/C/D,
-- ACC-04 (malak_audit) and ACC-05 are deliberately NOT addressed here.
--
-- Down migration: 20260914000001_acc02a_customer_order_expense_readonly_down.sql

-- ── customers ───────────────────────────────────────────────────────────────
revoke all on public.customers from anon;
revoke insert, update, delete, truncate, references, trigger
  on public.customers from authenticated;
drop policy if exists "authenticated_all_customers" on public.customers;
create policy "customers_select_authenticated"
  on public.customers for select to authenticated using (true);

-- ── orders ──────────────────────────────────────────────────────────────────
revoke all on public.orders from anon;
revoke insert, update, delete, truncate, references, trigger
  on public.orders from authenticated;
drop policy if exists "authenticated_all_orders" on public.orders;
create policy "orders_select_authenticated"
  on public.orders for select to authenticated using (true);

-- ── expenses ────────────────────────────────────────────────────────────────
revoke all on public.expenses from anon;
revoke insert, update, delete, truncate, references, trigger
  on public.expenses from authenticated;
drop policy if exists "authenticated_all_expenses" on public.expenses;
create policy "expenses_select_authenticated"
  on public.expenses for select to authenticated using (true);
