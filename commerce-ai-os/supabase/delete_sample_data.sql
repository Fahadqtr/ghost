-- ============================================================================
-- Commerce AI OS — remove ALL Phase 1 sample/test data
-- ----------------------------------------------------------------------------
-- Run this in the Supabase SQL Editor BEFORE loading your real clean product
-- database. It deletes every row created by seed_sample_data.sql (SKU LIKE 'TEST-%')
-- and its dependent rows. It does NOT touch the schema, brands, channels, or
-- categories.
-- ============================================================================

BEGIN;

DELETE FROM product_variants WHERE parent_product_id IN (SELECT id FROM products WHERE sku LIKE 'TEST-%');
DELETE FROM channel_products WHERE product_id        IN (SELECT id FROM products WHERE sku LIKE 'TEST-%');
DELETE FROM product_images   WHERE product_id        IN (SELECT id FROM products WHERE sku LIKE 'TEST-%');
DELETE FROM inventory        WHERE product_id        IN (SELECT id FROM products WHERE sku LIKE 'TEST-%');
DELETE FROM products         WHERE sku LIKE 'TEST-%';

COMMIT;

-- Verify it's gone (should return 0):
--   SELECT count(*) FROM products WHERE sku LIKE 'TEST-%';
