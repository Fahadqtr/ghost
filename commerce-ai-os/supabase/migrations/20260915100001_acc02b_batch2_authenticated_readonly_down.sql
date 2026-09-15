-- DOWN migration for 20260915100000_acc02b_batch2_authenticated_readonly.sql
-- (manual).
--
-- Restores the EXACT pre-change state of all five tables as read from production
-- immediately before the up migration ran:
--
--   relacl (all five, identical)
--     postgres=arwdDxtm/postgres | anon=arwdDxtm/postgres
--     authenticated=arwdDxtm/postgres | service_role=arwdDxtm/postgres
--
--   policies
--     products          "authenticated_all_products"           ALL/true/true
--                       "products_authenticated_all"           ALL/true/true  (two)
--     product_images    "authenticated_all_product_images"     ALL/true/true
--     channel_products  "authenticated_all_channel_products"   ALL/true/true
--     platform_status   "platform_status_all"                  ALL/true/true
--     agent_logs        "authenticated_all_agent_logs"         ALL/true/true
--
-- NOTE: reverting the DATABASE alone is not enough to restore the old behaviour
-- and is not required for the app to keep working. The companion code change
-- moved every writer to the service role, which keeps working either way; this
-- rollback only re-opens direct Data API write access for every signed-in
-- account. It exists so the change is reversible, not because reverting is
-- advisable. No rows are touched either way, so the rollback is lossless.
--
-- anon is not mentioned in either direction: the up migration did not change it.

-- ── products ────────────────────────────────────────────────────────────────
drop policy if exists "products_select_authenticated" on public.products;
create policy "authenticated_all_products"
  on public.products for all to authenticated using (true) with check (true);
create policy "products_authenticated_all"
  on public.products for all to authenticated using (true) with check (true);
grant insert, update, delete, truncate, references, trigger
  on public.products to authenticated;

-- ── product_images ──────────────────────────────────────────────────────────
drop policy if exists "product_images_select_authenticated" on public.product_images;
create policy "authenticated_all_product_images"
  on public.product_images for all to authenticated using (true) with check (true);
grant insert, update, delete, truncate, references, trigger
  on public.product_images to authenticated;

-- ── channel_products ────────────────────────────────────────────────────────
drop policy if exists "channel_products_select_authenticated" on public.channel_products;
create policy "authenticated_all_channel_products"
  on public.channel_products for all to authenticated using (true) with check (true);
grant insert, update, delete, truncate, references, trigger
  on public.channel_products to authenticated;

-- ── platform_status ─────────────────────────────────────────────────────────
drop policy if exists "platform_status_select_authenticated" on public.platform_status;
create policy "platform_status_all"
  on public.platform_status for all to authenticated using (true) with check (true);
grant insert, update, delete, truncate, references, trigger
  on public.platform_status to authenticated;

-- ── agent_logs ──────────────────────────────────────────────────────────────
drop policy if exists "agent_logs_select_authenticated" on public.agent_logs;
create policy "authenticated_all_agent_logs"
  on public.agent_logs for all to authenticated using (true) with check (true);
grant insert, update, delete, truncate, references, trigger
  on public.agent_logs to authenticated;
