-- ============================================================================
-- studio_reels — the Malika AI Studio library of finished reels + their full
-- recipe. Run ONCE in the Supabase SQL Editor of the PRODUCTION project
-- (vqstcmattiarhblqshvb). NEVER run against the legacy project
-- awlevukqqsaxvifrfteb. Safe to re-run.
--
-- The Final Reel Composer inserts one row per exported reel: the mp4 URL plus
-- everything needed to reproduce it (product, script, voice/caption/logo
-- settings, CTA, the FLORA generation). Until this runs, the composer still
-- works — it just skips the save step.
-- ============================================================================

create table if not exists public.studio_reels (
  id                uuid primary key default gen_random_uuid(),
  created_at        timestamptz not null default now(),
  status            text not null default 'ready',   -- ready | error
  video_url         text,                             -- the final Instagram-ready mp4
  product_sku       text,
  product_name      text,
  script            text,                             -- the Gulf-Arabic script spoken/captioned
  language          text,                             -- ar | en | ar_en
  voice_settings    jsonb,                            -- voice id / model / stability / style / speed
  flora_generation  jsonb,                            -- the FLORA video source + run info
  caption_settings  jsonb,                            -- language / font / position knobs
  logo_settings     jsonb,                            -- position / show
  cta               text
);

create index if not exists studio_reels_created_idx on public.studio_reels (created_at desc);

alter table public.studio_reels enable row level security;

drop policy if exists studio_reels_select on public.studio_reels;
create policy studio_reels_select on public.studio_reels
  for select to authenticated using (true);

drop policy if exists studio_reels_insert on public.studio_reels;
create policy studio_reels_insert on public.studio_reels
  for insert to authenticated with check (true);
