-- DOWN migration for 20260906000000_talabat_email_deliveries.sql (manual use).
-- Removes ONLY the Talabat email delivery audit table — nothing else.

drop index if exists public.talabat_email_deliveries_kind_idx;
drop table if exists public.talabat_email_deliveries;
