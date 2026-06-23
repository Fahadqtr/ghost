-- ============================================================================
-- Per-variant barcode  (run ONCE in the Supabase SQL editor)
-- ----------------------------------------------------------------------------
-- Adds a barcode column to product_variants so each option (e.g. iPhone 16 /
-- 16 Pro / 16 Pro Max) can carry its own scannable Code 128 barcode, printed
-- from the Inventory → Labels tool just like product barcodes.
-- Safe to re-run.
-- ============================================================================

ALTER TABLE product_variants
  ADD COLUMN IF NOT EXISTS barcode text;

-- Fast lookup when scanning a variant barcode at the shelf / till.
CREATE INDEX IF NOT EXISTS product_variants_barcode_idx
  ON product_variants (barcode)
  WHERE barcode IS NOT NULL;
