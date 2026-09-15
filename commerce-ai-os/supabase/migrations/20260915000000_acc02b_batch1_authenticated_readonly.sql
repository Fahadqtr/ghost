-- ACC-02B batch 1 — remove direct `authenticated` write privileges from ten
-- tables whose every legitimate application write already goes through the
-- service role (or a SECURITY DEFINER routine).
--
-- WHY THIS IS NOW SAFE, AND WASN'T BEFORE
-- The application authorization boundary was hardened first (D-4A1 team gate,
-- D-4A2 privileged paths, D-2 CRM/Loyalty). Service-role bypasses RLS entirely,
-- so no database grant could ever have constrained those paths — the app gate
-- had to move first. With that done, the remaining exposure is the Data API:
-- every table below carries Supabase's default blanket grants (arwdDxtm) AND a
-- permissive policy, so any account holding a valid session could INSERT,
-- UPDATE or DELETE rows directly, bypassing every TypeScript gate. Postgres
-- sees one interactive identity, `authenticated`.
--
-- HOW THESE TEN WERE CHOSEN
-- Every write path in app/, lib/, components/ and scripts/ was traced and
-- attributed to the client variable that performs it, so a file importing both
-- clients cannot be miscounted. A table is in this batch ONLY if it has no
-- direct `authenticated`-client writer anywhere:
--
--   staff_tasks                1633 rows  service-role only
--                              (app/(app)/tasks/actions.ts, app/staff/actions.ts,
--                               lib/tasks/{calendarSync,routines}.ts,
--                               lib/talabat/process-order.ts, lib/tasks/catalog-log.ts)
--   product_archive             395 rows  written ONLY by archive_product_bundle /
--                              restore_product_archive, which are SECURITY DEFINER,
--                              owned by postgres, and `authenticated` holds no
--                              EXECUTE on either
--   external_channel_listings  5531 rows  service-role only (lib/rafeeq/fullsync.server.ts
--                              uses createAdminClient for every ECL write;
--                              writeEclMapping receives an admin client from all
--                              four of its callers). Its policy is already
--                              SELECT-only, so this revoke is defence in depth:
--                              it removes the "one permissive policy away from
--                              catastrophe" path on marketplace identity rows.
--   shelf_slots                  33 rows  service-role only (app/(app)/inventory/actions.ts)
--   task_routines                 0 rows  service-role only (app/(app)/tasks/actions.ts)
--   task_comments                 0 rows  service-role only (lib/tasks/commentStore.ts,
--                              which takes the client as a parameter — both
--                              callers pass the admin client)
--   brands                       38 rows  NO writer anywhere; 15 read-only references
--   channels                      5 rows  NO writer anywhere; 10 read-only references
--   product_categories           17 rows  NO reference of any kind
--   pure_seoul_status             8 rows  NO reference of any kind
--
-- WHAT THIS DOES
--   authenticated -> SELECT only. INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/
--                    TRIGGER revoked, and each permissive ALL policy replaced
--                    with a SELECT-only policy so a future re-grant cannot
--                    silently restore write access.
--   anon          -> UNTOUCHED. Deliberately: anon grants are ACC-05's subject
--                    and are not mixed into this step.
--   service_role  -> UNTOUCHED. Every server-side workflow keeps working.
--
-- SELECT is retained for `authenticated` on all ten: readers exist for brands,
-- channels, staff_tasks and product_archive, and removing read access is a
-- separate question this step does not pre-empt.
--
-- NOT IN THIS BATCH, and why:
--   products, product_images, channel_products, platform_status, agent_logs
--     still have REAL direct `authenticated` writers (see the PR body) and need
--     code migration to the service role first — revoking now would break them.
--   malak_audit        blocked on the D-3 append-only decision.
--   export_runs, platform_snapshots  their authenticated INSERT policy is
--     deliberate and is the open D-5 decision.
--
-- SCOPE: the ten tables below ONLY. No schema, column, index, constraint or
-- trigger change; no row touched; no anon grant; no auth setting; no function.
--
-- Down migration: 20260915000001_acc02b_batch1_authenticated_readonly_down.sql

-- ── staff_tasks ─────────────────────────────────────────────────────────────
revoke insert, update, delete, truncate, references, trigger
  on public.staff_tasks from authenticated;
drop policy if exists "staff_tasks owner full access" on public.staff_tasks;
create policy "staff_tasks_select_authenticated"
  on public.staff_tasks for select to authenticated using (true);

-- ── product_archive ─────────────────────────────────────────────────────────
revoke insert, update, delete, truncate, references, trigger
  on public.product_archive from authenticated;
drop policy if exists "product_archive owner full access" on public.product_archive;
create policy "product_archive_select_authenticated"
  on public.product_archive for select to authenticated using (true);

-- ── external_channel_listings (policy already SELECT-only; grant only) ──────
revoke insert, update, delete, truncate, references, trigger
  on public.external_channel_listings from authenticated;

-- ── shelf_slots ─────────────────────────────────────────────────────────────
revoke insert, update, delete, truncate, references, trigger
  on public.shelf_slots from authenticated;
drop policy if exists "shelf_slots_rw" on public.shelf_slots;
create policy "shelf_slots_select_authenticated"
  on public.shelf_slots for select to authenticated using (true);

-- ── task_routines ───────────────────────────────────────────────────────────
revoke insert, update, delete, truncate, references, trigger
  on public.task_routines from authenticated;
drop policy if exists "task_routines owner full access" on public.task_routines;
create policy "task_routines_select_authenticated"
  on public.task_routines for select to authenticated using (true);

-- ── task_comments ───────────────────────────────────────────────────────────
revoke insert, update, delete, truncate, references, trigger
  on public.task_comments from authenticated;
drop policy if exists "task_comments owner full access" on public.task_comments;
create policy "task_comments_select_authenticated"
  on public.task_comments for select to authenticated using (true);

-- ── brands ──────────────────────────────────────────────────────────────────
revoke insert, update, delete, truncate, references, trigger
  on public.brands from authenticated;
drop policy if exists "authenticated_all_brands" on public.brands;
create policy "brands_select_authenticated"
  on public.brands for select to authenticated using (true);

-- ── channels ────────────────────────────────────────────────────────────────
revoke insert, update, delete, truncate, references, trigger
  on public.channels from authenticated;
drop policy if exists "authenticated_all_channels" on public.channels;
create policy "channels_select_authenticated"
  on public.channels for select to authenticated using (true);

-- ── product_categories ──────────────────────────────────────────────────────
revoke insert, update, delete, truncate, references, trigger
  on public.product_categories from authenticated;
drop policy if exists "authenticated_all_product_categories" on public.product_categories;
create policy "product_categories_select_authenticated"
  on public.product_categories for select to authenticated using (true);

-- ── pure_seoul_status ───────────────────────────────────────────────────────
revoke insert, update, delete, truncate, references, trigger
  on public.pure_seoul_status from authenticated;
drop policy if exists "ps_status_all" on public.pure_seoul_status;
create policy "pure_seoul_status_select_authenticated"
  on public.pure_seoul_status for select to authenticated using (true);
