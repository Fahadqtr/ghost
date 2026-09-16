-- Rollback for ACC-05 batch 2 — restores the exact `anon` privilege set these
-- fourteen tables carried before the revoke: Supabase's default blanket grant,
-- which is what ALL PRIVILEGES resolves to on a table (arwdDxtm, plus MAINTAIN
-- on PostgreSQL 17).
--
-- Restoring these grants does NOT re-open the Data API to anon on its own: no
-- policy in `public` targets anon, so the grants go back to being inert. This
-- file exists so the change is reversible in one step, not because anything is
-- expected to need it.

GRANT ALL PRIVILEGES ON TABLE public.products                  TO anon;
GRANT ALL PRIVILEGES ON TABLE public.product_images            TO anon;
GRANT ALL PRIVILEGES ON TABLE public.product_archive           TO anon;
GRANT ALL PRIVILEGES ON TABLE public.channel_products          TO anon;
GRANT ALL PRIVILEGES ON TABLE public.channel_variant_mappings  TO anon;
GRANT ALL PRIVILEGES ON TABLE public.channels                  TO anon;
GRANT ALL PRIVILEGES ON TABLE public.external_channel_listings TO anon;
GRANT ALL PRIVILEGES ON TABLE public.platform_status           TO anon;
GRANT ALL PRIVILEGES ON TABLE public.platform_snapshots        TO anon;
GRANT ALL PRIVILEGES ON TABLE public.malak_audit               TO anon;
GRANT ALL PRIVILEGES ON TABLE public.export_runs               TO anon;
GRANT ALL PRIVILEGES ON TABLE public.rafeeq_package_jobs       TO anon;
GRANT ALL PRIVILEGES ON TABLE public.talabat_package_jobs      TO anon;
GRANT ALL PRIVILEGES ON TABLE public.staff_tasks               TO anon;
