-- Rollback for ACC-05 batch 3 — restores the exact `anon` privilege set these
-- 23 tables carried before the revoke: Supabase's default blanket grant, which
-- is what ALL PRIVILEGES resolves to on a table (arwdDxtm, plus MAINTAIN on
-- PostgreSQL 17).
--
-- Restoring these grants does NOT re-open the Data API to anon on its own: no
-- policy in `public` targets anon, so the grants go back to being inert. This
-- file exists so the change is reversible in one step, not because anything is
-- expected to need it.

GRANT ALL PRIVILEGES ON TABLE public.agent_logs               TO anon;
GRANT ALL PRIVILEGES ON TABLE public.brands                   TO anon;
GRANT ALL PRIVILEGES ON TABLE public.compliance_log           TO anon;
GRANT ALL PRIVILEGES ON TABLE public.compliance_rules         TO anon;
GRANT ALL PRIVILEGES ON TABLE public.import_batches           TO anon;
GRANT ALL PRIVILEGES ON TABLE public.kpi_snapshots            TO anon;
GRANT ALL PRIVILEGES ON TABLE public.loop_log                 TO anon;
GRANT ALL PRIVILEGES ON TABLE public.loop_state               TO anon;
GRANT ALL PRIVILEGES ON TABLE public.loyalty_prizes           TO anon;
GRANT ALL PRIVILEGES ON TABLE public.marketing_posts          TO anon;
GRANT ALL PRIVILEGES ON TABLE public.product_categories       TO anon;
GRANT ALL PRIVILEGES ON TABLE public.pure_seoul_status        TO anon;
GRANT ALL PRIVILEGES ON TABLE public.rafeeq_email_deliveries  TO anon;
GRANT ALL PRIVILEGES ON TABLE public.rafeeq_package_items     TO anon;
GRANT ALL PRIVILEGES ON TABLE public.rafeeq_packages          TO anon;
GRANT ALL PRIVILEGES ON TABLE public.shelf_slots              TO anon;
GRANT ALL PRIVILEGES ON TABLE public.snoonu_sync_audits       TO anon;
GRANT ALL PRIVILEGES ON TABLE public.social_posts             TO anon;
GRANT ALL PRIVILEGES ON TABLE public.talabat_email_deliveries TO anon;
GRANT ALL PRIVILEGES ON TABLE public.talabat_queue            TO anon;
GRANT ALL PRIVILEGES ON TABLE public.task_comments            TO anon;
GRANT ALL PRIVILEGES ON TABLE public.task_routines            TO anon;
GRANT ALL PRIVILEGES ON TABLE public.tasks                    TO anon;
