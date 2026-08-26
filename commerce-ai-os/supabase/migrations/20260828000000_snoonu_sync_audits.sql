-- SNOONU CATALOG SYNC — durable apply audit (additive only).
--
-- One row per OWNER-CONFIRMED apply of a Snoonu update workbook: the source
-- file, when/who, the exact counts the owner saw, and the per-change record
-- (matched field diffs incl. previous/new availability + price, created
-- products, removed/stopped products, SKU/barcode changes). Pure audit —
-- nothing reads it for behavior, and it never alters catalog state.

create table if not exists public.snoonu_sync_audits (
  id uuid primary key default gen_random_uuid(),
  source_file text not null,
  applied_at timestamptz not null,
  actor text not null,
  import_mode text not null check (import_mode in ('FULL','PARTIAL')),
  counts jsonb not null,
  changes jsonb not null,
  fingerprint text not null,
  created_at timestamptz not null default now()
);

create index if not exists snoonu_sync_audits_applied_idx
  on public.snoonu_sync_audits (applied_at desc);

alter table public.snoonu_sync_audits enable row level security;
-- service-role only (admin client); no anon/authenticated policies on purpose.
