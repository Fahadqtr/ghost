-- ACC-05 batch 2 — remove `anon` privileges on the catalog, channel, audit and
-- job tables. Batch 1 (20260915300000) took the credential and customer-PII
-- tables; this is the operational core.
--
-- WHY THIS IS SAFE
--
-- A Data API request needs BOTH a grant and a permissive policy for its role.
-- Re-measured at the time of this migration: `public` holds 38 policies and
-- every one of them is `TO authenticated`. None targets `anon`; none is
-- `TO PUBLIC`, which would have included anon. So anon's effective access to
-- the schema is zero, and revoking a grant it cannot use removes nothing that
-- anyone has today.
--
-- What it removes is the standing half of a two-part hazard. These tables carry
-- Supabase's default blanket grant for anon (arwdDxtm, plus MAINTAIN on PG17),
-- so one future permissive policy — or one `TO public` policy added by mistake —
-- would hand the publishable anon key, which ships in the browser bundle by
-- design, read AND write access to the entire product catalog, every channel
-- listing, and the full privileged-action audit trail.
--
-- THE FOURTEEN
--
--   products                   1581   the catalog itself
--   product_images             2697
--   product_archive             395   soft-deleted products, restorable
--   channel_products           5596   per-channel price and status
--   channel_variant_mappings   1454   marketplace identity mapping
--   channels                      5
--   external_channel_listings  5531   marketplace identity rows
--   platform_status            6324   per-platform availability
--   platform_snapshots         7797   captured marketplace state
--   malak_audit                1188   the privileged-action audit trail
--   export_runs                  10
--   rafeeq_package_jobs           7   export job state
--   talabat_package_jobs         15   export job state
--   staff_tasks                1633   staff task state
--
-- NO ANON CONSUMER EXISTS
--
-- No code changed since the batch 1 audit, so that end-to-end trace of the
-- unauthenticated surfaces still holds: /login and /auth/recovery reach GoTrue
-- only, and /staff, /rewards, /api/rewards/*, /api/cron/* and /api/webhooks/*
-- all use the service role, which this migration does not touch.
--
-- Every reference form was scanned for these fourteen: double-quoted (374 hits),
-- single-quoted (10), backtick (0) and constant-resolved (10). The only browser
-- (anon-key) client that touches any of them is app/(app)/catalog/health/
-- page.tsx, and it is not an anon consumer: the page sits behind the app's auth
-- gate, so its role is `authenticated`, and middleware canonically redirects
-- /catalog/health to /v2/operations/health, so it is unreachable in any case.
--
-- Indirect exposure was checked too, not assumed. `public` holds one view,
-- loop_board, which reads loop_state (not in this batch) and which anon cannot
-- SELECT. Of the 25 functions in `public`, exactly one is executable by anon —
-- set_updated_at — and it is a SECURITY INVOKER trigger function returning
-- `trigger`, so it is not callable as an RPC and carries no privileges of its
-- own. Zero SECURITY DEFINER functions are executable by anon.
--
-- SELECT IS REVOKED TOO
--
-- There is no public read workflow on any of the fourteen, so no minimum anon
-- permission needs preserving. `REVOKE ALL PRIVILEGES` also covers MAINTAIN,
-- which PostgreSQL 17 added and which the default grant includes.
--
-- SCOPE: anon only. authenticated and service_role are untouched, no policy is
-- created, altered or dropped, and no data is read or written.

REVOKE ALL PRIVILEGES ON TABLE public.products                  FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.product_images            FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.product_archive           FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.channel_products          FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.channel_variant_mappings  FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.channels                  FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.external_channel_listings FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.platform_status           FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.platform_snapshots        FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.malak_audit               FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.export_runs               FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.rafeeq_package_jobs       FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.talabat_package_jobs      FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.staff_tasks               FROM anon;
