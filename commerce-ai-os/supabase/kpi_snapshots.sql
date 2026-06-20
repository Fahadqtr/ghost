-- Daily KPI snapshots — powers the "vs previous day" trends on the manager
-- dashboard. One row per calendar day (upserted by the app via the service-role
-- key, which bypasses RLS). RLS is enabled with no public policies, so the table
-- is reachable only through the server-side admin client — never from the browser.
--
-- Run this once in Supabase → SQL editor. The dashboard degrades gracefully
-- until it exists (no trends shown), then lights up automatically. A delta needs
-- two days of history, so arrows appear the day after the first snapshot.

create table if not exists public.kpi_snapshots (
  snapshot_date     date primary key,
  total_products    integer not null default 0,
  published_active  integer not null default 0,
  published_channels integer not null default 0,
  missing_price     integer not null default 0,
  missing_image     integer not null default 0,
  missing_barcode   integer not null default 0,
  missing_category  integer not null default 0,
  approved_count    integer not null default 0,
  rejected_count    integer not null default 0,
  inventory_units   integer not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

alter table public.kpi_snapshots enable row level security;
-- No policies on purpose: only the service-role key (server-side) may read/write.
