-- ============================================================================
-- export_runs — Phase INT.2E.2 (Durable Export/Publish Audit).
--
-- A GENERIC, append-only record of one Export Center publish/generate RUN — the
-- durable history SAT.1 found missing. One table for ALL destinations
-- (shopify:malikas, and future channels): each row is one operator-confirmed
-- run, with its aggregate counts, the confirmed preview fingerprint, and a
-- BOUNDED per-item result array in metadata (no separate child table — schema
-- stays minimal, §14).
--
-- This table NEVER modifies products, inventory, availability, lifecycle, or
-- external_channel_listings — it only RECORDS what a run did. Rows are immutable
-- (insert-only; no update/delete policy): a run is written ONCE at completion
-- with its terminal status. It stores NO credentials, tokens, cookies, or raw
-- Shopify payloads (§13, §20).
--
-- ADDITIVE + idempotent — safe to re-run. Run ONCE in the Supabase SQL Editor of
-- the PRODUCTION project ONLY after separate explicit approval (INT.2E.2 ships
-- the migration but does NOT apply it). The publisher tolerates an unmigrated
-- database: export_runs writes are best-effort and fall back to malak_audit.
--
-- Rollback: see supabase/export_runs_down.sql.
-- ============================================================================

create table if not exists public.export_runs (
  id                  uuid primary key default gen_random_uuid(),
  destination         text        not null,               -- storefront key, e.g. shopify:malikas
  operation           text        not null,               -- e.g. publish
  status              text        not null,                -- STARTED|SUCCEEDED|PARTIAL|FAILED|CANCELLED
  actor               text,                                -- operator email (identity only)
  started_at          timestamptz not null default now(),
  finished_at         timestamptz,
  product_count       integer     not null default 0,
  variant_count       integer     not null default 0,
  image_count         integer     not null default 0,
  created_count       integer     not null default 0,
  updated_count       integer     not null default 0,
  unchanged_count     integer     not null default 0,
  blocked_count       integer     not null default 0,
  failed_count        integer     not null default 0,
  warning_count       integer     not null default 0,
  preview_fingerprint text,                                -- confirmed batch fingerprint
  external_refs       jsonb       not null default '[]'::jsonb, -- created/updated GIDs (no payloads)
  error_summary       text,                                -- fixed/safe text only, never raw DB/Shopify errors
  metadata            jsonb       not null default '{}'::jsonb, -- bounded per-item results (§14)
  created_at          timestamptz not null default now()
);

-- Per-destination history (detail "recent runs" + latest run lookups).
create index if not exists export_runs_destination_created_idx
  on public.export_runs (destination, created_at desc);

-- Actor activity scans.
create index if not exists export_runs_actor_created_idx
  on public.export_runs (actor, created_at desc);

-- RLS: signed-in app users may READ and INSERT (a run is recorded in a
-- writer-gated server action under the user's session — same trust model as
-- platform_snapshots). There is deliberately NO update/delete policy: a run is
-- an immutable, append-only record written once at completion.
alter table public.export_runs enable row level security;

drop policy if exists export_runs_select on public.export_runs;
create policy export_runs_select on public.export_runs
  for select to authenticated using (true);

drop policy if exists export_runs_insert on public.export_runs;
create policy export_runs_insert on public.export_runs
  for insert to authenticated with check (true);
