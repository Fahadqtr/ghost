-- ============================================================================
-- Per-variant shelf distribution  (run ONCE in the Supabase SQL editor)
-- ----------------------------------------------------------------------------
-- For products that have options/variants (product_variants), this records how
-- many units of EACH variant sit in EACH shelf. A variant's stock_quantity is
-- kept = the sum of its shelf rows, and the parent product's inventory total is
-- kept = the sum of its variants' stock.
-- Safe to re-run.
-- ============================================================================

CREATE TABLE IF NOT EXISTS variant_shelf_stock (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id  uuid        NOT NULL,
  location    text        NOT NULL,
  quantity    int         NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (variant_id, location)
);
CREATE INDEX IF NOT EXISTS variant_shelf_stock_var_idx ON variant_shelf_stock (variant_id);
CREATE INDEX IF NOT EXISTS variant_shelf_stock_loc_idx ON variant_shelf_stock (location);

ALTER TABLE variant_shelf_stock ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS variant_shelf_stock_rw ON variant_shelf_stock;
CREATE POLICY variant_shelf_stock_rw ON variant_shelf_stock
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
