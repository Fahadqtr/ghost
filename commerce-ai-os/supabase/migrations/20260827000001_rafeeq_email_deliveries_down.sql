-- DOWN migration for 20260827000000_rafeeq_email_deliveries.sql (manual use).
-- Removes ONLY the email delivery audit table — nothing else is touched.

drop index if exists public.rafeeq_email_deliveries_job_idx;
drop table if exists public.rafeeq_email_deliveries;
