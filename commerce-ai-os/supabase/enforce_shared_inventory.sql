-- ============================================================================
-- OPTIONAL hard enforcement of the single shared-inventory principle.
-- ----------------------------------------------------------------------------
-- Principle: ALL channels (both Snoonu storefronts, Shopify, Talabat, Rafeeq)
-- draw from ONE shared inventory pool. The `inventory` table is the only source
-- of stock truth. `channel_products.channel_stock` must always be NULL — there
-- is no per-channel stock.
--
-- This adds a CHECK constraint so the database itself rejects any attempt to
-- write a per-channel stock value. It is a SCHEMA change (adds a constraint,
-- does not alter columns/data) — run it only if you want DB-level enforcement.
--
-- Pre-req: channel_stock must already be NULL everywhere (it is — verified).
-- ============================================================================

ALTER TABLE channel_products
  ADD CONSTRAINT channel_products_no_per_channel_stock
  CHECK (channel_stock IS NULL);

-- To verify:
--   SELECT count(*) FROM channel_products WHERE channel_stock IS NOT NULL;  -- expect 0
-- To undo:
--   ALTER TABLE channel_products DROP CONSTRAINT channel_products_no_per_channel_stock;
