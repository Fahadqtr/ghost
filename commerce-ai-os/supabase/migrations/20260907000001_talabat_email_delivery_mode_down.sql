-- DOWN migration for 20260907000000_talabat_email_delivery_mode.sql (manual).
-- Removes ONLY the delivery-mode column and its index.

drop index if exists public.talabat_email_deliveries_mode_idx;
alter table public.talabat_email_deliveries drop column if exists delivery_mode;
