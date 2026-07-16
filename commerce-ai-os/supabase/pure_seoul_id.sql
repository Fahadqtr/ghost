-- Pure Seoul is a separate Snoonu merchant whose SPI(UniqueIdentifier) lives in a
-- different namespace than our products.snoonu_id. Store the Pure Seoul SPI per
-- product so future Pure Seoul syncs/fills match by id (exact) instead of by name.
-- Run once in Supabase (SQL editor). Safe to re-run.

alter table products add column if not exists pure_seoul_id text;

-- Fast lookups by Pure Seoul id; only the rows that carry one are indexed.
create index if not exists idx_products_pure_seoul_id
  on products (pure_seoul_id)
  where pure_seoul_id is not null;
