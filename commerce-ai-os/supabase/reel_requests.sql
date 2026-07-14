-- ============================================================================
-- reel_requests — a queue of "professional reel" requests (Higgsfield Marketing
-- Studio talking-avatar UGC). Run ONCE in the Supabase SQL Editor of the
-- PRODUCTION project (vqstcmattiarhblqshvb). NEVER run against the legacy
-- project awlevukqqsaxvifrfteb. Safe to re-run.
--
-- Flow: the owner taps «اطلب ريل احترافي» → a pending row here (product + style
-- + desired schedule + notes). The reel is generated via Marketing Studio, the
-- resulting mp4 URL is pasted back → the request is scheduled into social_posts
-- (reusing the existing Reels queue) and marked done.
-- ============================================================================

create table if not exists public.reel_requests (
  id            uuid primary key default gen_random_uuid(),
  sku           text,
  product_name  text,
  style         text,                         -- Marketing Studio mode slug (e.g. ugc_gadget_saved_me)
  notes         text,                         -- Arabic direction / script notes for the reel
  script        text,                         -- AI-written Gulf-Arabic voiceover script (spoken verbatim)
  scheduled_at  timestamptz,                  -- desired publish slot (optional)
  status        text not null default 'pending', -- pending | scheduled | cancelled
  video_url     text,                         -- the finished mp4 once generated
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

-- If the table already exists from an earlier version, add the script column.
alter table public.reel_requests add column if not exists script text;

create index if not exists reel_requests_status_idx on public.reel_requests (status, created_at desc);

alter table public.reel_requests enable row level security;

-- Signed-in app users can read/write reel requests (server actions use the
-- service role and bypass RLS; these cover any direct authenticated access).
drop policy if exists reel_requests_select on public.reel_requests;
create policy reel_requests_select on public.reel_requests
  for select to authenticated using (true);

drop policy if exists reel_requests_insert on public.reel_requests;
create policy reel_requests_insert on public.reel_requests
  for insert to authenticated with check (true);

drop policy if exists reel_requests_update on public.reel_requests;
create policy reel_requests_update on public.reel_requests
  for update to authenticated using (true);
