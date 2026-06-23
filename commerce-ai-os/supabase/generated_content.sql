-- ============================================================================
-- generated_content — stores AI-generated Instagram content per product.
-- Separate table; NEVER modifies products. Run in the Supabase SQL Editor of the
-- correct project (vqstcmattiarhblqshvb).
-- ============================================================================

create table if not exists public.generated_content (
  id          uuid primary key default gen_random_uuid(),
  sku         text not null,
  caption_ar  text,
  caption_en  text,
  hashtags    text[],
  image_url   text,
  video_url   text,
  status      text default 'draft',
  created_at  timestamptz default now()
);

create index if not exists generated_content_sku_idx on public.generated_content (sku);

alter table public.generated_content enable row level security;

-- Signed-in app users can read/write their generated content.
drop policy if exists generated_content_select on public.generated_content;
create policy generated_content_select on public.generated_content
  for select to authenticated using (true);

drop policy if exists generated_content_insert on public.generated_content;
create policy generated_content_insert on public.generated_content
  for insert to authenticated with check (true);

drop policy if exists generated_content_update on public.generated_content;
create policy generated_content_update on public.generated_content
  for update to authenticated using (true);
