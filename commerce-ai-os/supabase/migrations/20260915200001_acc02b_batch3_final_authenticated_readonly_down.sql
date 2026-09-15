-- DOWN migration for 20260915200000_acc02b_batch3_final_authenticated_readonly.sql
-- (manual).
--
-- Restores the EXACT pre-change state of all six tables as read from production
-- immediately before the up migration ran:
--
--   relacl (all six, identical)
--     postgres=arwdDxtm/postgres | anon=arwdDxtm/postgres
--     authenticated=arwdDxtm/postgres | service_role=arwdDxtm/postgres
--
--   policies
--     malak_audit         "malak_audit_auth_all"                ALL/true/true
--     export_runs         "export_runs_insert"                  INSERT/-/true
--                         "export_runs_select"                  SELECT/true   (untouched)
--     platform_snapshots  "platform_snapshots_insert"           INSERT/-/true
--                         "platform_snapshots_select"           SELECT/true   (untouched)
--     marketing_posts     "authenticated_all_marketing_posts"   ALL/true/true
--     import_batches      "authenticated_all_import_batches"    ALL/true/true
--     tasks               "authenticated_all_tasks"             ALL/true/true
--
-- NOTE: reverting the DATABASE alone does not restore the old behaviour and is
-- not required for the app to keep working. The companion code change moved the
-- Snapshot Engine to the service role and raised the /agents gate; both keep
-- working either way. This rollback only re-opens direct Data API write access
-- for every signed-in account. It exists so the change is reversible, not
-- because reverting is advisable. No rows are touched, so it is lossless.
--
-- anon is not mentioned in either direction: the up migration did not change it.

-- ── malak_audit ─────────────────────────────────────────────────────────────
drop policy if exists "malak_audit_select_authenticated" on public.malak_audit;
create policy "malak_audit_auth_all"
  on public.malak_audit for all to authenticated using (true) with check (true);
grant insert, update, delete, truncate, references, trigger
  on public.malak_audit to authenticated;

-- ── export_runs (select policy was never touched) ───────────────────────────
create policy "export_runs_insert"
  on public.export_runs for insert to authenticated with check (true);
grant insert, update, delete, truncate, references, trigger
  on public.export_runs to authenticated;

-- ── platform_snapshots (select policy was never touched) ────────────────────
create policy "platform_snapshots_insert"
  on public.platform_snapshots for insert to authenticated with check (true);
grant insert, update, delete, truncate, references, trigger
  on public.platform_snapshots to authenticated;

-- ── marketing_posts ─────────────────────────────────────────────────────────
drop policy if exists "marketing_posts_select_authenticated" on public.marketing_posts;
create policy "authenticated_all_marketing_posts"
  on public.marketing_posts for all to authenticated using (true) with check (true);
grant insert, update, delete, truncate, references, trigger
  on public.marketing_posts to authenticated;

-- ── import_batches ──────────────────────────────────────────────────────────
drop policy if exists "import_batches_select_authenticated" on public.import_batches;
create policy "authenticated_all_import_batches"
  on public.import_batches for all to authenticated using (true) with check (true);
grant insert, update, delete, truncate, references, trigger
  on public.import_batches to authenticated;

-- ── tasks ───────────────────────────────────────────────────────────────────
drop policy if exists "tasks_select_authenticated" on public.tasks;
create policy "authenticated_all_tasks"
  on public.tasks for all to authenticated using (true) with check (true);
grant insert, update, delete, truncate, references, trigger
  on public.tasks to authenticated;
