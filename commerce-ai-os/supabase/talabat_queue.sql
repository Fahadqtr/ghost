-- Talabat new-product queue.
-- Talabat has no dashboard entry for us: new products go by EMAIL (Excel sheet
-- + images ZIP). Every product that becomes Approved lands here; the owner
-- downloads the package from /import-export/talabat-sync, sends the email,
-- then marks the batch sent (sent_at) — after which it no longer shows.
-- Run once in the Supabase SQL editor.

create table if not exists public.talabat_queue (
  product_id uuid primary key references public.products(id) on delete cascade,
  queued_at  timestamptz not null default now(),
  sent_at    timestamptz,          -- null = still waiting for the email
  sent_by    text                  -- owner email that marked it sent
);

create index if not exists talabat_queue_pending_idx
  on public.talabat_queue (queued_at) where sent_at is null;

-- Service-role access only (the app uses the admin key; no anon/user policies).
alter table public.talabat_queue enable row level security;
