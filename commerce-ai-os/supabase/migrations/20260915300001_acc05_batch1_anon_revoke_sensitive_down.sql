-- Rollback for ACC-05 batch 1 — restores the exact `anon` privilege set the ten
-- tables carried before the revoke: Supabase's default blanket grant, which is
-- what ALL PRIVILEGES resolves to on a table (arwdDxtm).
--
-- Restoring these grants does NOT by itself re-open the Data API to anon: no
-- policy in `public` targets anon, so the grants go back to being inert. This
-- file exists so the change is reversible in one step, not because anything is
-- expected to depend on it.

GRANT ALL PRIVILEGES ON TABLE public.shopify_tokens        TO anon;
GRANT ALL PRIVILEGES ON TABLE public.staff_members         TO anon;
GRANT ALL PRIVILEGES ON TABLE public.push_subscriptions    TO anon;
GRANT ALL PRIVILEGES ON TABLE public.app_settings          TO anon;
GRANT ALL PRIVILEGES ON TABLE public.loyalty_customers     TO anon;
GRANT ALL PRIVILEGES ON TABLE public.loyalty_submissions   TO anon;
GRANT ALL PRIVILEGES ON TABLE public.dm_conversations      TO anon;
GRANT ALL PRIVILEGES ON TABLE public.dm_messages           TO anon;
GRANT ALL PRIVILEGES ON TABLE public.shopify_synced_orders TO anon;
GRANT ALL PRIVILEGES ON TABLE public.talabat_orders        TO anon;
