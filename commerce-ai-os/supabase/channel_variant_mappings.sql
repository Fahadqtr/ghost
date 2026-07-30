-- channel_variant_mappings — the standalone "flattened" product that a master
-- variant becomes on a channel that does NOT support product options (Talabat).
-- Run ONCE in the Supabase SQL editor of the PRODUCTION project
-- (vqstcmattiarhblqshvb). Safe to re-run (fully idempotent).
--
-- Malika's Master Catalogue stays the source of truth: this table only RECORDS
-- how a master product/variant is represented on a channel. It holds NO master
-- data and NO per-channel stock (there is no channel_stock column — every
-- channel draws from the single `inventory` pool, per enforce_shared_inventory).
--
-- DURABLE LINK = (channel_id, master_product_id, master_variant_sku).
-- We deliberately do NOT store product_variants.id: variants are deleted and
-- re-inserted whenever a product is edited, so their ids are not stable — the
-- variant SKU is the durable key.
--   * master_variant_sku IS NULL  -> the master product has no variants.
--   * master_variant_sku IS set   -> the flattened row for that one variant.

create table if not exists public.channel_variant_mappings (
  id                 uuid primary key default gen_random_uuid(),
  channel_id         uuid not null references public.channels(id)  on delete cascade,
  master_product_id  uuid not null references public.products(id)  on delete cascade,
  master_variant_sku text,                                 -- NULL = no-variant product
  exported_sku       text not null,                        -- flattened SKU sent to the channel
  exported_barcode   text,                                 -- NULL until a valid barcode exists
  channel_product_id text,                                 -- external id from Talabat (NULL until known)
  mapping_status     text not null default 'active'
                     check (mapping_status in ('active','needs_review','archived')),
  export_snapshot    jsonb not null default '{}'::jsonb,   -- last-exported field snapshot (preview only)
  last_exported_at   timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- One flattened SKU per channel.
create unique index if not exists channel_variant_mappings_channel_sku_uk
  on public.channel_variant_mappings (channel_id, exported_sku);

-- One external channel product id per channel — enforced only once it is known.
create unique index if not exists channel_variant_mappings_channel_cpid_uk
  on public.channel_variant_mappings (channel_id, channel_product_id)
  where channel_product_id is not null;

-- At most one mapping per (channel, master product, variant SKU). A no-variant
-- product (NULL variant sku) is normalized to '' so it occupies a single slot.
create unique index if not exists channel_variant_mappings_identity_uk
  on public.channel_variant_mappings
     (channel_id, master_product_id, coalesce(master_variant_sku, ''));

-- Lookup indexes for order matching and the catalogue UI.
create index if not exists channel_variant_mappings_cpid_idx
  on public.channel_variant_mappings (channel_product_id) where channel_product_id is not null;
create index if not exists channel_variant_mappings_exported_sku_idx
  on public.channel_variant_mappings (exported_sku);
create index if not exists channel_variant_mappings_barcode_idx
  on public.channel_variant_mappings (exported_barcode) where exported_barcode is not null;
create index if not exists channel_variant_mappings_product_idx
  on public.channel_variant_mappings (master_product_id);
create index if not exists channel_variant_mappings_variant_sku_idx
  on public.channel_variant_mappings (master_variant_sku) where master_variant_sku is not null;

-- RLS: authenticated may READ (catalogue UI). Writes go ONLY through the
-- service-role key (server actions / API) — there is intentionally no
-- insert/update/delete policy, so the browser cannot write. Mirrors the
-- talabat_orders pattern (never `for all ... using (true)`).
alter table public.channel_variant_mappings enable row level security;
drop policy if exists channel_variant_mappings_select on public.channel_variant_mappings;
create policy channel_variant_mappings_select on public.channel_variant_mappings
  for select to authenticated using (true);
