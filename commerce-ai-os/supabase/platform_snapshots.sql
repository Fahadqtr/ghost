-- ============================================================================
-- platform_snapshots — Phase UI.9.3 (Platform Snapshot Persistence).
--
-- A GENERIC, append-only record of "what a platform said about a product" at a
-- point in time, feeding the Platform Snapshot Engine (PR #532). One table for
-- ALL platforms (pure_seoul, shopify, talabat, rafeeq, …) — there is no
-- PureSoul-specific table and no separate `differences` table: a diff is derived
-- from two snapshots by the engine, so nothing is duplicated.
--
-- This table NEVER modifies products, inventory, or platform_status — it only
-- RECORDS observations. Rows are immutable (insert-only; no update/delete
-- policy). Run ONCE in the Supabase SQL Editor of the PRODUCTION project
-- (vqstcmattiarhblqshvb). Fully idempotent — safe to re-run.
--
-- Rollback: see supabase/platform_snapshots_down.sql.
-- ============================================================================

create table if not exists public.platform_snapshots (
  id               uuid primary key default gen_random_uuid(),
  platform         text        not null,                 -- opaque platform id
  product_id       uuid        references public.products(id) on delete cascade,
  external_id      text,                                  -- platform's own id (nullable)
  sku              text,
  barcode          text,
  status           text,                                  -- platform status (e.g. Rejected)
  price            numeric,                               -- platform price (nullable)
  availability     text,                                  -- InStock | OutOfStock | null
  title            text,
  payload_hash     text        not null,                  -- engine content hash
  snapshot_version integer     not null default 1 check (snapshot_version >= 1),
  captured_at      timestamptz not null default now(),    -- observation time (caller-supplied)
  metadata         jsonb       not null default '{}'::jsonb,
  created_at       timestamptz not null default now()     -- row insert time
);

-- Latest-per-(platform, product) lookups (dashboard read + compareLatest).
create index if not exists platform_snapshots_latest_idx
  on public.platform_snapshots (platform, product_id, captured_at desc);

-- Platform-wide freshness / listing scans ("last PureSoul snapshot").
create index if not exists platform_snapshots_platform_captured_idx
  on public.platform_snapshots (platform, captured_at desc);

-- RLS: signed-in app users may READ and INSERT (capture runs in a server action
-- under the user's session — same trust model as generated_content). There is
-- deliberately NO update/delete policy: snapshots are an immutable, append-only
-- history, so even an authenticated client cannot mutate or erase past records.
alter table public.platform_snapshots enable row level security;

drop policy if exists platform_snapshots_select on public.platform_snapshots;
create policy platform_snapshots_select on public.platform_snapshots
  for select to authenticated using (true);

drop policy if exists platform_snapshots_insert on public.platform_snapshots;
create policy platform_snapshots_insert on public.platform_snapshots
  for insert to authenticated with check (true);
