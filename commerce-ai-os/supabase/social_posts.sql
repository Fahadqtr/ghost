-- Social content queue (run once in the production SQL editor — idempotent).
--
-- One row per (daily post × platform). The generator inserts rows as
-- 'pending'; the owner reviews at /social and publishes (→ 'posted') or
-- dismisses (→ 'dismissed'); failures keep the row with the error for retry.
-- RLS enabled with NO policies: service-role only (API/actions).

create table if not exists social_posts (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid,
  platform    text not null,                 -- 'instagram' | 'tiktok'
  caption     text not null,
  image_url   text not null,
  status      text not null default 'pending', -- pending | posted | failed | dismissed
  external_id text,                          -- IG media id / TikTok publish id
  error       text,
  created_at  timestamptz not null default now(),
  posted_at   timestamptz
);

create index if not exists social_posts_status_idx on social_posts (status, created_at desc);

alter table social_posts enable row level security;
