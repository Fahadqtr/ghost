-- ACC-05 batch 1 — remove `anon` privileges on the ten most sensitive tables.
--
-- WHY THIS IS SAFE
--
-- A Data API request needs BOTH a grant and a permissive policy for its role.
-- An audit of every policy in `public` found 38 policies, and every single one
-- of them is `TO authenticated`: not one policy targets `anon`, and not one is
-- `TO PUBLIC` (which would include anon). So anon's effective access to the
-- whole schema is already zero, and revoking the grant cannot remove access
-- that anyone currently has.
--
-- What it DOES remove is the standing half of a two-part hazard: these tables
-- carry Supabase's default blanket grant (arwdDxtm) for anon, so a single
-- future permissive policy — or one `TO public` policy added by mistake — turns
-- the publishable anon key, which ships in the browser bundle by design, into
-- read AND write access on staff PINs, a Shopify Admin API token, and customer
-- PII. Removing the grant means that mistake fails closed.
--
-- WHY THESE TEN FIRST
--
-- They are the credential-bearing and customer-PII tables. Every one has ZERO
-- policies of any kind, so there is nothing here to preserve for any role:
--
--   shopify_tokens          access_token — Shopify Admin API credential
--   staff_members           pin — the shared staff gate credential, + permissions
--   push_subscriptions      endpoint / p256dh / auth — Web Push crypto material
--   app_settings            steers which address supplier emails are sent to
--   loyalty_customers       customer name + phone
--   loyalty_submissions     customer receipt images
--   dm_conversations        customer social identities
--   dm_messages             customer message bodies
--   shopify_synced_orders   order ids + payment gateway names
--   talabat_orders          customer_name, total, raw order payload
--
-- NO PUBLIC WORKFLOW IS BROKEN
--
-- The unauthenticated surfaces — /login, /auth/recovery, /staff, /rewards,
-- /api/rewards/*, /api/cron/*, /api/webhooks/* — were traced end to end. The
-- auth pages talk to GoTrue only (no table in `public`). Every other public
-- route reaches the database through createAdminClient(), i.e. the service
-- role, which this migration does not touch. No browser client anywhere issues
-- a .from() against these ten tables, there are no Edge Functions, and
-- supabase_realtime publishes no tables.
--
-- SELECT IS REVOKED TOO, DELIBERATELY
--
-- No public READ workflow exists on any of these ten either, so there is no
-- minimum anon permission to preserve. Leaving SELECT granted would keep the
-- same latent hazard for the data that matters most.
--
-- SCOPE: anon only. authenticated and service_role are untouched, no policy is
-- created, altered or dropped, and no data is read or written.

REVOKE ALL PRIVILEGES ON TABLE public.shopify_tokens        FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.staff_members         FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.push_subscriptions    FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.app_settings          FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.loyalty_customers     FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.loyalty_submissions   FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.dm_conversations      FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.dm_messages           FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.shopify_synced_orders FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.talabat_orders        FROM anon;
