-- ============================================================================
-- Shelf / bin locations  (run ONCE in the Supabase SQL editor)
-- ----------------------------------------------------------------------------
-- Adds a physical location to each inventory row (e.g. 'A1', 'B3') and a small
-- `shelf_slots` table that holds the formal shelf map: which shelves (A, B, C…)
-- exist and which slots are in each. The app reads/writes these.
-- Safe to re-run (IF NOT EXISTS / idempotent policies).
-- ============================================================================

-- 1) Per-product physical location, referencing a slot code.
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS location text;
CREATE INDEX IF NOT EXISTS inventory_location_idx ON inventory (location);

-- 2) The formal shelf map: one row per slot (e.g. code 'A1', shelf 'A').
CREATE TABLE IF NOT EXISTS shelf_slots (
  code        text        PRIMARY KEY,          -- 'A1', 'A2', 'B1' …
  shelf       text        NOT NULL,             -- 'A', 'B', 'C' …
  sort        int         NOT NULL DEFAULT 0,   -- ordering within a shelf
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shelf_slots_shelf_idx ON shelf_slots (shelf, sort);

-- 3) Let signed-in users read and manage the shelf map.
ALTER TABLE shelf_slots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS shelf_slots_rw ON shelf_slots;
CREATE POLICY shelf_slots_rw ON shelf_slots
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
