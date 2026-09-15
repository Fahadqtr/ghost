-- DOWN migration for 20260915000000_acc02b_batch1_authenticated_readonly.sql
-- (manual).
--
-- Restores the EXACT pre-change state of all ten tables as read from production
-- immediately before the up migration ran:
--
--   relacl (all ten, identical)
--     postgres=arwdDxtm/postgres | anon=arwdDxtm/postgres
--     authenticated=arwdDxtm/postgres | service_role=arwdDxtm/postgres
--
--   policies
--     staff_tasks                "staff_tasks owner full access"            ALL/true/true
--     product_archive            "product_archive owner full access"        ALL/true/true
--     shelf_slots                "shelf_slots_rw"                           ALL/true/true
--     task_routines              "task_routines owner full access"          ALL/true/true
--     task_comments              "task_comments owner full access"          ALL/true/true
--     brands                     "authenticated_all_brands"                 ALL/true/true
--     channels                   "authenticated_all_channels"               ALL/true/true
--     product_categories         "authenticated_all_product_categories"     ALL/true/true
--     pure_seoul_status          "ps_status_all"                            ALL/true/true
--     external_channel_listings  "ecl_select"  SELECT/true  — NOT modified by
--                                the up migration, so it is not recreated here
--
-- Running this restores unrestricted Data API write access for every signed-in
-- account to task state, archived product bundles, marketplace identity rows,
-- shelf layout and the reference tables. It exists so the change is reversible,
-- not because reverting is advisable. No rows are touched either way, so the
-- rollback is lossless.
--
-- anon is not mentioned in either direction: the up migration did not change it.

-- ── staff_tasks ─────────────────────────────────────────────────────────────
drop policy if exists "staff_tasks_select_authenticated" on public.staff_tasks;
create policy "staff_tasks owner full access"
  on public.staff_tasks for all to authenticated using (true) with check (true);
grant insert, update, delete, truncate, references, trigger
  on public.staff_tasks to authenticated;

-- ── product_archive ─────────────────────────────────────────────────────────
drop policy if exists "product_archive_select_authenticated" on public.product_archive;
create policy "product_archive owner full access"
  on public.product_archive for all to authenticated using (true) with check (true);
grant insert, update, delete, truncate, references, trigger
  on public.product_archive to authenticated;

-- ── external_channel_listings (grant only; ecl_select was never touched) ────
grant insert, update, delete, truncate, references, trigger
  on public.external_channel_listings to authenticated;

-- ── shelf_slots ─────────────────────────────────────────────────────────────
drop policy if exists "shelf_slots_select_authenticated" on public.shelf_slots;
create policy "shelf_slots_rw"
  on public.shelf_slots for all to authenticated using (true) with check (true);
grant insert, update, delete, truncate, references, trigger
  on public.shelf_slots to authenticated;

-- ── task_routines ───────────────────────────────────────────────────────────
drop policy if exists "task_routines_select_authenticated" on public.task_routines;
create policy "task_routines owner full access"
  on public.task_routines for all to authenticated using (true) with check (true);
grant insert, update, delete, truncate, references, trigger
  on public.task_routines to authenticated;

-- ── task_comments ───────────────────────────────────────────────────────────
drop policy if exists "task_comments_select_authenticated" on public.task_comments;
create policy "task_comments owner full access"
  on public.task_comments for all to authenticated using (true) with check (true);
grant insert, update, delete, truncate, references, trigger
  on public.task_comments to authenticated;

-- ── brands ──────────────────────────────────────────────────────────────────
drop policy if exists "brands_select_authenticated" on public.brands;
create policy "authenticated_all_brands"
  on public.brands for all to authenticated using (true) with check (true);
grant insert, update, delete, truncate, references, trigger
  on public.brands to authenticated;

-- ── channels ────────────────────────────────────────────────────────────────
drop policy if exists "channels_select_authenticated" on public.channels;
create policy "authenticated_all_channels"
  on public.channels for all to authenticated using (true) with check (true);
grant insert, update, delete, truncate, references, trigger
  on public.channels to authenticated;

-- ── product_categories ──────────────────────────────────────────────────────
drop policy if exists "product_categories_select_authenticated" on public.product_categories;
create policy "authenticated_all_product_categories"
  on public.product_categories for all to authenticated using (true) with check (true);
grant insert, update, delete, truncate, references, trigger
  on public.product_categories to authenticated;

-- ── pure_seoul_status ───────────────────────────────────────────────────────
drop policy if exists "pure_seoul_status_select_authenticated" on public.pure_seoul_status;
create policy "ps_status_all"
  on public.pure_seoul_status for all to authenticated using (true) with check (true);
grant insert, update, delete, truncate, references, trigger
  on public.pure_seoul_status to authenticated;
