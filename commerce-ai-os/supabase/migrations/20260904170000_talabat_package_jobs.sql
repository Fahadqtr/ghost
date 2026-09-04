-- ============================================================================
-- TALABAT.PKGJOB — CHUNKED PACKAGE-GENERATION JOBS (additive, idempotent).
--
-- STEP 74. The certified Talabat package (1343 master products, 1454 sellable
-- rows, 2501 planned images) cannot be generated inside one serverless
-- request. Measured on the real current catalogue:
--
--     workbook build                       0.9 s
--     image download 2501 x ~333 KB       ~775 s at concurrency 6   <-- wall
--     ZIP assembly                         8.9 s  (799 MB archive)
--     peak buffered memory                ~1.6 GB                   <-- wall
--
-- Two independent ceilings: the 300 s function limit AND the instance memory
-- limit. Raising maxDuration cannot fix either, which is why generation moves
-- to a resumable JOB — the same model rafeeq_package_jobs already uses.
-- Bounded step requests each fetch a small image batch, commit one durable ZIP
-- part to the private `talabat-packages` bucket, and persist resumable state;
-- the artifact is the ordered concatenation of the parts, streamed at download.
--
--   • talabat_package_jobs — one bookkeeping row per generation job. The
--     resumable engine state and the artifact parts live in the storage
--     bucket (jobs/<id>/plan.json, state.json, part-NNNNN); this row exists
--     for queryability, idempotent start, and the optimistic step claim.
--
-- STRICT SCOPE:
--   • purely ADDITIVE — one new table + the private storage bucket row;
--   • NO existing table/column is altered or dropped; NO data backfill;
--   • package CONTENT is unchanged: master scope, pricing policy, barcode
--     alias, category resolver and row selection are all untouched. This
--     migration changes only WHERE and IN HOW MANY REQUESTS the work runs;
--   • NOT auto-applied — this migration ships in the PR and awaits explicit
--     production approval.
-- ============================================================================

create table if not exists public.talabat_package_jobs (
  id                    uuid primary key default gen_random_uuid(),
  -- the single certified destination; kept explicit so the idempotent-start
  -- lookup and any future channel stay unambiguous.
  channel               text not null default 'talabat:malikas'
                          check (channel in ('talabat:malikas')),
  mode                  text not null default 'ready' check (mode in ('ready', 'selected')),
  status                text not null default 'queued'
                          check (status in ('queued', 'running', 'completed', 'failed')),
  -- the engine's own stage label, surfaced verbatim to the progress UI.
  stage                 text not null default 'PREPARING'
                          check (stage in ('PREPARING', 'BUILDING_WORKBOOK', 'DOWNLOADING_IMAGES',
                                           'BUILDING_ARCHIVE', 'UPLOADING_ARTIFACT', 'SYNCING_MAPPINGS',
                                           'FINALIZING', 'COMPLETED')),
  -- optimistic claim counter: a step driver advances it with
  -- `update … set step = <seen>+1 where id = ? and step = <seen>`, so two
  -- concurrent drivers can never run the same step twice.
  step                  integer not null default 0,
  progress_current      integer not null default 0,
  progress_total        integer not null default 0,
  rows_total            integer not null default 0,
  products_total        integer not null default 0,
  bytes_done            bigint  not null default 0,
  artifact_filename     text,
  artifact_bytes        bigint,
  artifact_sha256       text,
  manifest_fingerprint  text,
  -- set ONLY when the finalize step recorded the audit trail row.
  audit_recorded        boolean not null default false,
  -- set ONLY when the mapping sync step completed.
  mappings_synced       boolean not null default false,
  error_code            text,
  error_ref             text,
  created_by            text,
  started_at            timestamptz not null default now(),
  completed_at          timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- Idempotent start + "show the running job instead of starting another one".
create index if not exists talabat_package_jobs_channel_status_idx
  on public.talabat_package_jobs (channel, status, created_at desc);

-- STEP 75 — the DB is the FINAL authority on "one active job per channel".
-- The application still does a SELECT-then-INSERT for UX (resume the live job
-- instead of erroring), but that check has a wide race window: it spans a full
-- bounded catalogue read, so two concurrent starts could both observe "no live
-- job" and both insert. Two active jobs would mean two artifacts, two mapping
-- syncs and two audit rows.
--
-- This PARTIAL unique index closes that race in the database: at most one row
-- per channel may be queued or running at any instant. The loser of a race
-- receives 23505 and is served the already-active job instead of an error.
-- Terminal rows (completed / failed) are outside the predicate, so history is
-- unbounded and a replacement job can always start once the previous one ends.
create unique index if not exists talabat_package_jobs_one_active_idx
  on public.talabat_package_jobs (channel)
  where status in ('queued', 'running');

alter table public.talabat_package_jobs enable row level security;
-- No anon/authenticated policies: only the service-role server layer touches
-- job rows (same posture as rafeeq_package_jobs).

-- Private storage bucket for job plans/state and artifact parts. Service-role
-- access only (storage RLS applies to anon/authenticated; none is granted).
insert into storage.buckets (id, name, public)
values ('talabat-packages', 'talabat-packages', false)
on conflict (id) do nothing;
