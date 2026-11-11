-- DOWN for 20261111000000_loyalty_brand.sql.
--
-- Restores the single-store schema. Pure Seoul rows must be removed first
-- (or this fails on the unique(phone) re-add when a number exists in both
-- stores) — that deletion is deliberately NOT done here; it needs an explicit
-- owner decision.

drop index if exists public.loyalty_prizes_brand_active_idx;
create index if not exists loyalty_prizes_active_idx
  on public.loyalty_prizes (active, sort_order, created_at);

alter table public.loyalty_prizes drop constraint if exists loyalty_prizes_brand_check;
alter table public.loyalty_prizes drop column if exists brand;

alter table public.loyalty_customers drop constraint if exists loyalty_customers_brand_phone_key;
alter table public.loyalty_customers add constraint loyalty_customers_phone_key unique (phone);
alter table public.loyalty_customers drop constraint if exists loyalty_customers_brand_check;
alter table public.loyalty_customers drop column if exists brand;
