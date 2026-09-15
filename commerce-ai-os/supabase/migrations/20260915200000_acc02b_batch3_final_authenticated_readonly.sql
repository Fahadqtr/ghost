-- ACC-02B batch 3 — close the LAST six tables a signed-in account could still
-- write through the Data API, taking effective authenticated writes to ZERO.
--
-- WHAT WAS STILL OPEN, AND WHY EACH IS SAFE NOW
--
--   malak_audit         1188 rows. ALL/true policy. STEP 13 proved this table is
--                       MIXED, not append-only: approveMovements legitimately
--                       UPDATEs `details` on an existing row to stamp review
--                       metadata. That writer is SERVICE-ROLE and writer-gated,
--                       as is every insertAuditRow caller, so revoking the
--                       authenticated grants costs nothing. The table is NOT
--                       being converted to append-only.
--
--   export_runs           10 rows. Its authenticated INSERT policy was DEAD: the
--                       only writer, recordExportRun, is reached solely from
--                       publish.server.ts on the service-role client.
--
--   platform_snapshots  7797 rows. This was the one genuine authenticated
--                       INSERT. OWNER DECISION: do not keep it. The companion
--                       commit moves the Snapshot Engine's insert to the service
--                       role, preserving requireOwner on all four capture
--                       actions — and RAISING the one capture path that was on a
--                       bare session check, rather than lowering the boundary to
--                       meet it. Reads are unaffected: authenticated SELECT stays.
--
--   marketing_posts        0 rows, zero code references of any kind
--   import_batches         0 rows, zero code references of any kind
--   tasks                  0 rows, zero code references of any kind (staff_tasks
--                       is the live table; this one is a legacy leftover)
--
-- THE TWO INSERT POLICIES ARE DROPPED, NOT JUST THE GRANTS
-- export_runs_insert and platform_snapshots_insert were real policies with
-- WITH CHECK (true). Revoking the grant is sufficient today, but leaving a
-- permissive INSERT policy in place means a future re-grant silently restores
-- Data API write access. Both are replaced by nothing; SELECT keeps its own
-- policy.
--
-- WHAT THIS DOES
--   authenticated -> SELECT only on all six. INSERT/UPDATE/DELETE/TRUNCATE/
--                    REFERENCES/TRIGGER revoked; every permissive write policy
--                    dropped and, where the table had only an ALL policy,
--                    replaced with a SELECT-only one.
--   anon          -> UNTOUCHED (ACC-05's subject).
--   service_role  -> UNTOUCHED.
--
-- SELECT is retained for `authenticated` on all six: malak_audit feeds the audit
-- and movements views, export_runs the export history, platform_snapshots the
-- platform matrix and history readers.
--
-- SCOPE: the six tables below ONLY. No schema, column, index, constraint or
-- trigger change; no row touched; no anon grant; no auth setting; no function.
--
-- Down migration: 20260915200001_acc02b_batch3_final_authenticated_readonly_down.sql

-- ── malak_audit (ALL policy → SELECT-only) ──────────────────────────────────
revoke insert, update, delete, truncate, references, trigger
  on public.malak_audit from authenticated;
drop policy if exists "malak_audit_auth_all" on public.malak_audit;
create policy "malak_audit_select_authenticated"
  on public.malak_audit for select to authenticated using (true);

-- ── export_runs (dead INSERT policy dropped; SELECT policy kept as-is) ──────
revoke insert, update, delete, truncate, references, trigger
  on public.export_runs from authenticated;
drop policy if exists "export_runs_insert" on public.export_runs;

-- ── platform_snapshots (INSERT policy dropped; SELECT policy kept as-is) ────
revoke insert, update, delete, truncate, references, trigger
  on public.platform_snapshots from authenticated;
drop policy if exists "platform_snapshots_insert" on public.platform_snapshots;

-- ── marketing_posts ─────────────────────────────────────────────────────────
revoke insert, update, delete, truncate, references, trigger
  on public.marketing_posts from authenticated;
drop policy if exists "authenticated_all_marketing_posts" on public.marketing_posts;
create policy "marketing_posts_select_authenticated"
  on public.marketing_posts for select to authenticated using (true);

-- ── import_batches ──────────────────────────────────────────────────────────
revoke insert, update, delete, truncate, references, trigger
  on public.import_batches from authenticated;
drop policy if exists "authenticated_all_import_batches" on public.import_batches;
create policy "import_batches_select_authenticated"
  on public.import_batches for select to authenticated using (true);

-- ── tasks ───────────────────────────────────────────────────────────────────
revoke insert, update, delete, truncate, references, trigger
  on public.tasks from authenticated;
drop policy if exists "authenticated_all_tasks" on public.tasks;
create policy "tasks_select_authenticated"
  on public.tasks for select to authenticated using (true);
