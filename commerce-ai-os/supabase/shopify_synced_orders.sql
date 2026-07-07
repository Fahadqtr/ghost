-- Shopify orders already deducted from our inventory (run once in the
-- production SQL editor — idempotent).
--
-- The nightly inventory sync (and the manual button) reads recent store
-- orders, deducts their line items from the inventory table, and records the
-- order ids here so nothing is ever deducted twice. The very first run only
-- baselines the existing orders (deducted = 0) without touching stock.
-- RLS enabled with NO policies: service-role only.

create table if not exists shopify_synced_orders (
  order_id   text primary key,          -- gid://shopify/Order/…
  order_name text,                      -- "#1042"
  deducted   int not null default 0,    -- items actually subtracted
  synced_at  timestamptz not null default now()
);

alter table shopify_synced_orders enable row level security;
