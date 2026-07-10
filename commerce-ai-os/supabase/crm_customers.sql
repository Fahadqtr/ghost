-- CRM: per-customer notes + manual tags, keyed to a source record.
-- The live stats (spend, orders, last activity, segment) are computed on read
-- from Shopify + the DM inbox — this table only PERSISTS what the owner adds:
-- notes and tags. Run once in the SQL editor.
--
-- source     : 'shopify' (a Shopify customer) | 'dm' (a dm_conversations row)
-- source_id  : the Shopify customer gid, or the dm_conversations.id
-- Service-role only (admin pages use the service key). RLS on, no policies.

create table if not exists public.crm_customers (
  id         uuid primary key default gen_random_uuid(),
  source     text not null,
  source_id  text not null,
  name       text,
  phone      text,
  instagram  text,
  email      text,
  notes      text,
  tags       text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source, source_id)
);

alter table public.crm_customers enable row level security;
