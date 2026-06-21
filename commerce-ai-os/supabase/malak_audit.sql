-- ============================================================================
-- malak_audit — append-only log of every WRITE Malak executes (Phase 2B).
-- ----------------------------------------------------------------------------
-- Created MANUALLY in the Supabase SQL Editor (Malak never creates tables via
-- the service key). /api/malak/commit inserts ONE row per confirmed write.
--
-- If you already created this table manually, make sure its columns match the
-- ones below (same names/types). The commit endpoint inserts exactly these
-- columns; an extra/renamed column will make the audit insert fail (the write
-- itself still succeeds — the API returns audit:"failed: ..." so you can spot it).
-- ============================================================================

CREATE TABLE IF NOT EXISTS malak_audit (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  action_type text        NOT NULL,            -- update_stock | set_price | set_approval | add_product
  agent       text,                            -- razan | noor | reem
  sku         text,
  product_id  uuid,
  field       text,                            -- stock_quantity | price | approval | add_product
  old_value   text,
  new_value   text,
  details     jsonb,                           -- full signed action payload
  status      text        DEFAULT 'committed'
);

-- Optional: quick lookups by product / recency.
CREATE INDEX IF NOT EXISTS malak_audit_product_idx ON malak_audit (product_id);
CREATE INDEX IF NOT EXISTS malak_audit_created_idx ON malak_audit (created_at DESC);
