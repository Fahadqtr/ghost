-- ============================================================================
-- RAFEEQ.PKGJOB — CHUNKED PACKAGE-GENERATION JOBS (additive, idempotent).
--
-- The FULL native Rafeeq package (~1419 products, ~2535 images, ~500 MiB)
-- cannot be generated inside one serverless request: the single-shot path was
-- OOM-killed by the runtime and previously hit the 300 s ceiling. Generation
-- now runs as a resumable JOB: bounded step requests each commit one durable
-- ZIP part to the private `rafeeq-packages` storage bucket; the artifact is
-- the ordered concatenation of the parts, streamed at download time.
--
--   • rafeeq_package_jobs — one bookkeeping row per generation job. The
--     resumable engine state and the artifact parts live in the storage
--     bucket (jobs/<id>/plan.json, state.json, part-NNNNN); this row exists
--     for queryability, idempotent start, and the optimistic step claim.
--
-- STRICT SCOPE:
--   • purely ADDITIVE — one new table + the private storage bucket row;
--   • NO existing table/column is altered or dropped; NO data backfill;
--   • a job row is NOT a package-history row: rafeeq_packages is still
--     written exactly once per successful generation (by the finalize step),
--     so failed/incomplete attempts can never masquerade as a valid package;
--   • NOT auto-applied — this migration ships in the PR and awaits explicit
--     production approval.
-- ============================================================================

create table if not exists public.rafeeq_package_jobs (
  id                    uuid primary key default gen_random_uuid(),
  mode                  text not null check (mode in ('FULL', 'NEW')),
  status                text not null default 'running' check (status in ('running', 'complete', 'failed')),
  -- optimistic claim counter: a step driver advances it with
  -- `update … set step = <seen>+1 where id = ? and step = <seen>`.
  step                  integer not null default 0,
  products_done         integer not null default 0,
  products_total        integer not null default 0,
  images_done           integer not null default 0,
  bytes_done            bigint  not null default 0,
  artifact_filename     text,
  artifact_bytes        bigint,
  manifest_fingerprint  text,
  -- set ONLY when the finalize step successfully recorded the package row.
  package_id            uuid,
  error_code            text,
  error_ref             text,
  created_by            text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists rafeeq_package_jobs_mode_status_idx
  on public.rafeeq_package_jobs (mode, status, created_at desc);

alter table public.rafeeq_package_jobs enable row level security;
-- No anon/authenticated policies: only the service-role server layer touches
-- job rows (same posture as rafeeq_packages).

-- Private storage bucket for job plans/state and artifact parts. Service-role
-- access only (storage RLS applies to anon/authenticated; none is granted).
insert into storage.buckets (id, name, public)
values ('rafeeq-packages', 'rafeeq-packages', false)
on conflict (id) do nothing;
