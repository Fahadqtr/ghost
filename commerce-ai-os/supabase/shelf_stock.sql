-- ============================================================================
-- Per-shelf stock distribution  (run ONCE in the Supabase SQL editor)
-- ----------------------------------------------------------------------------
-- A product can sit in several shelves at once. `shelf_stock` records HOW MANY
-- units are in each location. The master total stays `inventory.stock_quantity`
-- (unchanged) — this table is a distribution overlay. If the per-shelf sum does
-- not match the total, the app shows a "placed X / Y" warning.
-- Safe to re-run.
-- ============================================================================

CREATE TABLE IF NOT EXISTS shelf_stock (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  inventory_id  uuid        NOT NULL,
  location      text        NOT NULL,
  quantity      int         NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (inventory_id, location)
);
CREATE INDEX IF NOT EXISTS shelf_stock_inv_idx ON shelf_stock (inventory_id);
CREATE INDEX IF NOT EXISTS shelf_stock_loc_idx ON shelf_stock (location);

ALTER TABLE shelf_stock ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS shelf_stock_rw ON shelf_stock;
CREATE POLICY shelf_stock_rw ON shelf_stock
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Seed from the existing single-location assignments: each product that already
-- has a location gets one placement row holding its whole stock.
INSERT INTO shelf_stock (inventory_id, location, quantity)
SELECT id, location, COALESCE(stock_quantity, 0)
FROM inventory
WHERE location IS NOT NULL AND location <> ''
ON CONFLICT (inventory_id, location) DO NOTHING;
