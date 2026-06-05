-- ============================================================================
-- Add Snoonu sync columns to products (run in Supabase SQL Editor).
-- Safe & idempotent (IF NOT EXISTS). Adds nullable columns only — no data
-- changes, no impact on existing rows.
-- ============================================================================

ALTER TABLE products ADD COLUMN IF NOT EXISTS approval     text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS is_featured  boolean;
ALTER TABLE products ADD COLUMN IF NOT EXISTS is_promoted  boolean;
ALTER TABLE products ADD COLUMN IF NOT EXISTS has_buy1get1 boolean;

-- Verify:
--   SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_name='products'
--     AND column_name IN ('approval','is_featured','is_promoted','has_buy1get1');
