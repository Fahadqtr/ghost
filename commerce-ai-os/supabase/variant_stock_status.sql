-- ============================================================================
-- Per-variant explicit availability  (run ONCE in the Supabase SQL editor)
-- ----------------------------------------------------------------------------
-- INV.2E. Adds the variant analogue of products.stock_status so each option can
-- carry its own explicit availability ("In Stock" | "Out of Stock"), managed by
-- staff via the Availability Engine.
--
-- Availability is SEPARATE from quantity: this column never mirrors
-- product_variants.stock_quantity. It is NOT backfilled from quantity — NULL
-- means "unset" (unknown), and the app treats unset as not-available / inherits
-- the product-level availability where a fallback is defined. A backfill, if ever
-- wanted, is a separate reviewed step.
--
-- Additive + reversible. Safe to re-run.
--   Reverse:  ALTER TABLE product_variants DROP COLUMN IF EXISTS stock_status;
-- ============================================================================

ALTER TABLE product_variants
  ADD COLUMN IF NOT EXISTS stock_status text;
