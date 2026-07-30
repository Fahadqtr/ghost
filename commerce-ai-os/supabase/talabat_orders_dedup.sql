-- talabat_orders — order-processing idempotency foundation (Phase 2A.1).
-- Run ONCE in the Supabase SQL editor of the PRODUCTION project
-- (vqstcmattiarhblqshvb). ADDITIVE and idempotent (safe to re-run).
--
-- Adds only the columns the upcoming order-resolution phase needs. It does NOT:
--   * drop or rename any existing column,
--   * touch `raw` or `items`,
--   * deduct any stock,
--   * backfill old rows with guessed values (dedup_key / processed_at /
--     resolution stay NULL on existing rows; processing_status defaults to
--     'pending', which is accurate — those orders were never processed).

alter table public.talabat_orders add column if not exists dedup_key         text;
alter table public.talabat_orders add column if not exists processing_status text not null default 'pending';
alter table public.talabat_orders add column if not exists processed_at      timestamptz;
alter table public.talabat_orders add column if not exists resolution        jsonb;

-- Constrain processing_status to the known states. Added via a guarded block so
-- a re-run (or a table that already had the column) still acquires the check.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'talabat_orders_processing_status_chk'
  ) then
    alter table public.talabat_orders
      add constraint talabat_orders_processing_status_chk
      check (processing_status in ('pending','processed','manual_review','failed'));
  end if;
end $$;

-- Idempotency key: at most one order row per dedup_key, enforced only where the
-- key is set. Existing rows keep dedup_key NULL, so the partial index ignores
-- them (no guessed backfill).
create unique index if not exists talabat_orders_dedup_key_uk
  on public.talabat_orders (dedup_key) where dedup_key is not null;

-- Helps the resolution worker find still-unprocessed orders quickly.
create index if not exists talabat_orders_processing_status_idx
  on public.talabat_orders (processing_status) where processing_status <> 'processed';
