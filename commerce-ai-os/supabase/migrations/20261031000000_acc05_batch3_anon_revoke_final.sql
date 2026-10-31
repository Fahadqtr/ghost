-- ACC-05 batch 3 (FINAL) — remove `anon` privileges on the last 23 tables.
--
-- This completes ACC-05. After it, NO table, view or materialised view in
-- `public` carries a single privilege for the `anon` role.
--
-- WHY THIS IS SAFE
--
-- A Data API request needs BOTH a grant and a permissive policy for its role.
-- Re-measured for this batch: all 23 have RLS enabled, and not one policy in
-- `public` targets `anon` or `PUBLIC` (which would include anon). anon's
-- effective access is already zero, so revoking a grant it cannot use removes
-- nothing anyone has.
--
-- What it removes is the standing half of a two-part hazard: these tables still
-- carried Supabase's default blanket grant (arwdDxtm + MAINTAIN on PG17), so a
-- single future permissive policy — or one `TO public` policy added by mistake —
-- would hand the publishable anon key, which ships in the browser bundle by
-- design, read AND write access to them.
--
-- NO ANON CONSUMER EXISTS — RE-VERIFIED, NOT INHERITED
--
-- These 23 are reached 107 times across app/, lib/, components/ and scripts/.
-- Every single reference is a double-quoted literal (0 single-quoted, 0
-- backtick, 0 constant-resolved), and NONE of them sits in a file that builds
-- the browser (anon-key) client. All six browser-client files were checked.
--
-- The unauthenticated surfaces were re-scanned too: 20 files under
-- app/api/{cron,webhooks,rewards}/ and app/{rewards,staff}/ — not one uses a
-- session or browser client; they all go through createAdminClient(), i.e. the
-- service role, which this migration does not touch.
--
-- loyalty_prizes deserved its own check, because /rewards is the one genuinely
-- public page and it shows prizes. Every read and write of it in
-- lib/loyalty/rewards.ts runs on createAdminClient(). Confirmed, not assumed.
--
-- Indirect exposure: `public` holds one view, loop_board, which anon cannot
-- SELECT; of the functions in `public`, the only anon-executable one is
-- set_updated_at, a SECURITY INVOKER trigger function returning `trigger`, so
-- it is not callable as an RPC; zero SECURITY DEFINER functions are
-- anon-executable.
--
-- SCOPE: anon only. authenticated and service_role are untouched, no policy is
-- created, altered or dropped, and no data is read or written. `REVOKE ALL
-- PRIVILEGES` is used so MAINTAIN is covered; an enumerated list would miss it.

REVOKE ALL PRIVILEGES ON TABLE public.agent_logs               FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.brands                   FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.compliance_log           FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.compliance_rules         FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.import_batches           FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.kpi_snapshots            FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.loop_log                 FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.loop_state               FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.loyalty_prizes           FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.marketing_posts          FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.product_categories       FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.pure_seoul_status        FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.rafeeq_email_deliveries  FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.rafeeq_package_items     FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.rafeeq_packages          FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.shelf_slots              FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.snoonu_sync_audits       FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.social_posts             FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.talabat_email_deliveries FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.talabat_queue            FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.task_comments            FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.task_routines            FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.tasks                    FROM anon;
