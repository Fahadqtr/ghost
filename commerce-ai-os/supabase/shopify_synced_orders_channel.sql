-- Phase 2A.4 — Shopify POS channel attribution (ADDITIVE, run once in the
-- production SQL editor). Idempotent and non-destructive: it only ADDS two
-- columns to the existing shopify_synced_orders ledger. It does NOT recreate the
-- table, drop/rename anything, delete data, or change the deduction/idempotency
-- logic (order_id stays the primary key). Existing rows keep channel='shopify'.
--
-- A Talabat order is entered manually in Shopify POS with the custom payment
-- method "Talabat"; the sync classifies the channel purely from the order's
-- paymentGatewayNames and records it here. Inventory is still deducted exactly
-- once via the existing Shopify inventory-sync path — this migration adds no
-- deduction and touches no Talabat table.

-- Channel attribution: 'talabat' (POS custom payment method) or 'shopify'.
alter table public.shopify_synced_orders
  add column if not exists channel text not null default 'shopify';

-- The raw Shopify payment gateway names the classification was derived from
-- (kept for audit; not a card/payment secret).
alter table public.shopify_synced_orders
  add column if not exists payment_gateway_names jsonb;

-- Optional: quick filtering by channel in reports.
create index if not exists shopify_synced_orders_channel_idx
  on public.shopify_synced_orders (channel);

-- To verify (expect only 'talabat' / 'shopify'):
--   select channel, count(*) from public.shopify_synced_orders group by channel;
