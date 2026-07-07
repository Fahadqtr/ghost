-- Shopify OAuth token store (run once in the production SQL editor — idempotent).
--
-- One row per shop: the permanent offline Admin API token granted through
-- /api/shopify/install → /api/shopify/callback. RLS enabled with NO policies:
-- service-role only, never readable from the browser.

create table if not exists shopify_tokens (
  shop         text primary key,          -- "xxxxx.myshopify.com"
  access_token text not null,
  scope        text,
  updated_at   timestamptz not null default now()
);

alter table shopify_tokens enable row level security;
