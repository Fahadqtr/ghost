-- Archive of deleted products. Before a product is removed from the live
-- catalog, its full bundle (product row + inventory + variants + channel
-- listings) is snapshotted here, so a deletion is never truly destructive and
-- the owner can restore it later. Run once in the Supabase SQL editor.

create table if not exists public.product_archive (
  id uuid primary key default gen_random_uuid(),
  product_id uuid,
  sku text,
  barcode text,
  name_en text,
  name_ar text,
  image_url text,
  bundle jsonb not null,          -- { product, inventory, variants, channel_products }
  archived_by text,
  archived_at timestamptz not null default now()
);

create index if not exists product_archive_archived_at_idx on public.product_archive (archived_at desc);

alter table public.product_archive enable row level security;

drop policy if exists "product_archive owner full access" on public.product_archive;
create policy "product_archive owner full access" on public.product_archive
  for all to authenticated using (true) with check (true);
