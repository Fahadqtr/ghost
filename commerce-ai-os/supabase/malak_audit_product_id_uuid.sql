-- ============================================================================
-- malak_audit.product_id: legacy bigint → uuid (one-time, idempotent).
-- ----------------------------------------------------------------------------
-- Production's malak_audit was renamed from the old `audit_log` table, whose
-- product_id is a LEGACY BIGINT — while products.id is uuid. Writers therefore
-- kept the product uuid only inside details->>'productId' (unindexed JSON).
--
-- This migration converges the live table with the repo DDL (malak_audit.sql,
-- which already says uuid):
--   1. renames the bigint column to product_id_legacy (nothing is dropped),
--   2. adds a fresh product_id uuid column,
--   3. backfills it from details->>'productId' for the whole history,
--   4. rebuilds the product lookup index on the new column.
--
-- Safe to re-run. Run ONCE in the production SQL editor (vqstcmattiarhblqshvb).
-- App code (lib/audit.ts) works before AND after this runs — on an unmigrated
-- table it falls back to the legacy shape automatically.
-- ============================================================================

do $$
declare col_type text;
begin
  select data_type into col_type
    from information_schema.columns
   where table_schema = 'public'
     and table_name   = 'malak_audit'
     and column_name  = 'product_id';

  if col_type = 'bigint' then
    alter table public.malak_audit rename column product_id to product_id_legacy;
    alter table public.malak_audit add column product_id uuid;
  end if;
end $$;

-- Backfill history from the JSON workaround (valid uuids only; re-runnable).
update public.malak_audit
   set product_id = (details->>'productId')::uuid
 where product_id is null
   and details->>'productId' ~* '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$';

-- The old index (if any) followed the renamed bigint column — rebuild on uuid.
drop index if exists malak_audit_product_idx;
create index if not exists malak_audit_product_idx on public.malak_audit (product_id);

-- Verify: should return 'uuid' and a backfilled count.
-- select data_type from information_schema.columns
--  where table_name='malak_audit' and column_name='product_id';
-- select count(*) from malak_audit where product_id is not null;
