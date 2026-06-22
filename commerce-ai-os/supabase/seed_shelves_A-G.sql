-- ============================================================================
-- Seed shelves A–G  (run AFTER shelf_locations.sql, or instead of it — it
-- includes the same idempotent setup). Creates shelves A through G each with a
-- single starter slot (A1…G1) so all seven shelves show up on the Shelves page;
-- add the remaining slots from there.
-- ============================================================================

ALTER TABLE inventory ADD COLUMN IF NOT EXISTS location text;
CREATE INDEX IF NOT EXISTS inventory_location_idx ON inventory (location);

CREATE TABLE IF NOT EXISTS shelf_slots (
  code        text        PRIMARY KEY,
  shelf       text        NOT NULL,
  sort        int         NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shelf_slots_shelf_idx ON shelf_slots (shelf, sort);

ALTER TABLE shelf_slots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS shelf_slots_rw ON shelf_slots;
CREATE POLICY shelf_slots_rw ON shelf_slots
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

INSERT INTO shelf_slots (code, shelf, sort) VALUES
  ('A1','A',1), ('B1','B',1), ('C1','C',1),
  ('D1','D',1), ('E1','E',1), ('F1','F',1), ('G1','G',1)
ON CONFLICT (code) DO NOTHING;
