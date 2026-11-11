-- Beauty Rewards for Pure Seoul — same stamp system, separate store.
--
-- Adds a `brand` to loyalty customers and prizes so the Pure Seoul card
-- (/rewards/pureseoul, its own QR) has its OWN customers, hearts, prizes and
-- voucher codes, fully separate from Malika's Universe (/rewards).
--
-- Existing rows become brand = 'malikas' via the column default, so the
-- current Malika's program is unchanged. Submissions need no column: they hang
-- off a customer, whose brand they inherit.
--
-- Phone uniqueness moves from (phone) to (brand, phone): the same number may
-- hold one Malika's card AND one Pure Seoul card, never two of the same store.
--
-- No grants change: both tables stay RLS-on with no policies (service-role
-- only), exactly as before. Idempotent.

alter table public.loyalty_customers
  add column if not exists brand text not null default 'malikas';

alter table public.loyalty_customers
  drop constraint if exists loyalty_customers_brand_check;
alter table public.loyalty_customers
  add constraint loyalty_customers_brand_check check (brand in ('malikas', 'pureseoul'));

alter table public.loyalty_customers
  drop constraint if exists loyalty_customers_phone_key;
alter table public.loyalty_customers
  drop constraint if exists loyalty_customers_brand_phone_key;
alter table public.loyalty_customers
  add constraint loyalty_customers_brand_phone_key unique (brand, phone);

alter table public.loyalty_prizes
  add column if not exists brand text not null default 'malikas';

alter table public.loyalty_prizes
  drop constraint if exists loyalty_prizes_brand_check;
alter table public.loyalty_prizes
  add constraint loyalty_prizes_brand_check check (brand in ('malikas', 'pureseoul'));

drop index if exists public.loyalty_prizes_active_idx;
create index if not exists loyalty_prizes_brand_active_idx
  on public.loyalty_prizes (brand, active, sort_order, created_at);
