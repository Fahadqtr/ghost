-- ============================================================================
-- Commerce AI OS — Phase 1 SAMPLE/TEST seed data
-- ----------------------------------------------------------------------------
-- Run this in the Supabase SQL Editor (it does NOT modify the schema).
--
-- EVERYTHING here is TEST data:
--   • every product SKU starts with  TEST-
--   • every product.notes contains   'TEST/SAMPLE — delete before real data'
--
-- To remove ALL of it later in one shot, run supabase/delete_sample_data.sql
-- (or just: DELETE FROM products WHERE sku LIKE 'TEST-%';  + child cleanups).
--
-- Brands are matched by name pattern (ILIKE) so you don't need to know the UUIDs.
-- If your brand names differ, adjust the ILIKE patterns below.
-- ============================================================================

BEGIN;

-- Make this script safely re-runnable: clear any prior TEST rows first.
DELETE FROM product_variants WHERE parent_product_id IN (SELECT id FROM products WHERE sku LIKE 'TEST-%');
DELETE FROM channel_products WHERE product_id        IN (SELECT id FROM products WHERE sku LIKE 'TEST-%');
DELETE FROM product_images   WHERE product_id        IN (SELECT id FROM products WHERE sku LIKE 'TEST-%');
DELETE FROM inventory        WHERE product_id        IN (SELECT id FROM products WHERE sku LIKE 'TEST-%');
DELETE FROM products         WHERE sku LIKE 'TEST-%';

-- ---------------------------------------------------------------------------
-- PRODUCTS (8 across both brands). One per statement = no type-inference traps.
-- brand_id resolved via subquery: Malika's Universe -> %malika%, Pure Seoul -> %seoul%
-- ---------------------------------------------------------------------------

-- 1) Malika's Universe — Makeup — HAS 3 VARIANTS (Rhode Peptide Lip Tint)
INSERT INTO products (sku, barcode, name_en, name_ar, brand_id, main_category, sub_category, product_type, color, size, price, discount_price, cost, stock_quantity, stock_status, platform_status, image_filename, image_url, description_en, description_ar, keywords_en, keywords_ar, notes)
VALUES ('TEST-RHODE-LIPTINT', '0000000000011', 'Rhode Peptide Lip Tint', 'رود صبغة شفاه ببتيد',
  (SELECT id FROM brands WHERE name ILIKE '%malika%' ORDER BY name LIMIT 1),
  'Makeup', 'Lips', 'Lip Tint', 'Assorted', '10 ml', 75.00, 65.00, 40.00, 40, 'In Stock', 'Published',
  'rhode-lip-tint.jpg', 'https://example.com/rhode-lip-tint.jpg',
  'Hydrating peptide lip tint with a glossy finish.', 'صبغة شفاه مرطبة بالببتيد بلمسة لامعة.',
  'lip tint, peptide, gloss', 'صبغة شفاه, ببتيد', 'TEST/SAMPLE — delete before real data');

-- 2) Malika's Universe — Korean Skincare
INSERT INTO products (sku, barcode, name_en, name_ar, brand_id, main_category, sub_category, product_type, color, size, price, discount_price, cost, stock_quantity, stock_status, platform_status, image_filename, image_url, description_en, description_ar, keywords_en, keywords_ar, notes)
VALUES ('TEST-COSRX-SNAIL', '0000000000012', 'COSRX Advanced Snail 96 Mucin Essence', 'كوسركس إسنس الحلزون 96',
  (SELECT id FROM brands WHERE name ILIKE '%malika%' ORDER BY name LIMIT 1),
  'Korean Skincare', 'Essence', 'Essence', NULL, '100 ml', 90.00, NULL, 55.00, 25, 'In Stock', 'Published',
  'cosrx-snail.jpg', 'https://example.com/cosrx-snail.jpg',
  'Lightweight essence with 96% snail mucin.', 'إسنس خفيف يحتوي 96% ميوسين الحلزون.',
  'snail, essence, cosrx, hydration', 'حلزون, إسنس', 'TEST/SAMPLE — delete before real data');

-- 3) Malika's Universe — Beauty Tools — LOW STOCK demo (stock 3, threshold 5)
INSERT INTO products (sku, barcode, name_en, name_ar, brand_id, main_category, sub_category, product_type, color, size, price, discount_price, cost, stock_quantity, stock_status, platform_status, image_filename, image_url, description_en, description_ar, keywords_en, keywords_ar, notes)
VALUES ('TEST-BEAUTYBLENDER', '0000000000013', 'Beautyblender Original Sponge', 'إسفنجة بيوتي بلندر الأصلية',
  (SELECT id FROM brands WHERE name ILIKE '%malika%' ORDER BY name LIMIT 1),
  'Beauty Tools', 'Sponges', 'Sponge', 'Pink', 'One Size', 60.00, NULL, 30.00, 3, 'Low Stock', 'Published',
  'beautyblender.jpg', 'https://example.com/beautyblender.jpg',
  'Iconic edgeless makeup sponge for a flawless blend.', 'إسفنجة مكياج أيقونية لمزج مثالي.',
  'sponge, blender, makeup tool', 'إسفنجة, مكياج', 'TEST/SAMPLE — delete before real data');

-- 4) Malika's Universe — Gifts & Sets — MISSING IMAGE demo (image_url NULL)
INSERT INTO products (sku, barcode, name_en, name_ar, brand_id, main_category, sub_category, product_type, color, size, price, discount_price, cost, stock_quantity, stock_status, platform_status, image_filename, image_url, description_en, description_ar, keywords_en, keywords_ar, notes)
VALUES ('TEST-MALIKA-GIFTSET', '0000000000014', 'Malika Glow Gift Set', 'طقم مالكا جلو الهدية',
  (SELECT id FROM brands WHERE name ILIKE '%malika%' ORDER BY name LIMIT 1),
  'Gifts & Sets', 'Bundles', 'Gift Set', NULL, 'Set of 4', 199.00, 179.00, 110.00, 15, 'In Stock', 'Draft',
  NULL, NULL,
  'Curated glow gift set with four bestsellers.', 'طقم هدية متكامل يضم أربعة منتجات مميزة.',
  'gift set, bundle, glow', 'طقم هدية, مجموعة', 'TEST/SAMPLE — delete before real data');

-- 5) Malika's Universe — Thai Products
INSERT INTO products (sku, barcode, name_en, name_ar, brand_id, main_category, sub_category, product_type, color, size, price, discount_price, cost, stock_quantity, stock_status, platform_status, image_filename, image_url, description_en, description_ar, keywords_en, keywords_ar, notes)
VALUES ('TEST-THAI-INHALER', '0000000000015', 'Thai Herbal Inhaler', 'بخاخ الأعشاب التايلندي',
  (SELECT id FROM brands WHERE name ILIKE '%malika%' ORDER BY name LIMIT 1),
  'Thai Products', 'Wellness', 'Inhaler', NULL, '2 ml', 12.00, NULL, 5.00, 200, 'In Stock', 'Published',
  'thai-inhaler.jpg', 'https://example.com/thai-inhaler.jpg',
  'Refreshing traditional Thai herbal nasal inhaler.', 'بخاخ أنفي تايلندي تقليدي منعش بالأعشاب.',
  'thai, inhaler, herbal', 'تايلندي, أعشاب', 'TEST/SAMPLE — delete before real data');

-- 6) Pure Seoul — Korean Skincare
INSERT INTO products (sku, barcode, name_en, name_ar, brand_id, main_category, sub_category, product_type, color, size, price, discount_price, cost, stock_quantity, stock_status, platform_status, image_filename, image_url, description_en, description_ar, keywords_en, keywords_ar, notes)
VALUES ('TEST-PURESEOUL-CLEANSER', '0000000000016', 'Pure Seoul Green Tea Cleanser', 'بيور سيول غسول الشاي الأخضر',
  (SELECT id FROM brands WHERE name ILIKE '%seoul%' ORDER BY name LIMIT 1),
  'Korean Skincare', 'Cleanser', 'Cleanser', NULL, '150 ml', 55.00, 45.00, 28.00, 30, 'In Stock', 'Published',
  'pureseoul-cleanser.jpg', 'https://example.com/pureseoul-cleanser.jpg',
  'Gentle green tea gel cleanser for daily use.', 'غسول جل لطيف بالشاي الأخضر للاستخدام اليومي.',
  'cleanser, green tea, korean', 'غسول, شاي أخضر', 'TEST/SAMPLE — delete before real data');

-- 7) Pure Seoul — Korean Skincare — MISSING IMAGE demo (image_url NULL)
INSERT INTO products (sku, barcode, name_en, name_ar, brand_id, main_category, sub_category, product_type, color, size, price, discount_price, cost, stock_quantity, stock_status, platform_status, image_filename, image_url, description_en, description_ar, keywords_en, keywords_ar, notes)
VALUES ('TEST-PURESEOUL-SUNSCREEN', '0000000000017', 'Pure Seoul Daily Sunscreen SPF50', 'بيور سيول واقي شمس يومي SPF50',
  (SELECT id FROM brands WHERE name ILIKE '%seoul%' ORDER BY name LIMIT 1),
  'Korean Skincare', 'Sun Care', 'Sunscreen', NULL, '50 ml', 70.00, NULL, 38.00, 18, 'In Stock', 'Published',
  NULL, NULL,
  'Lightweight daily sunscreen, SPF50 PA++++.', 'واقي شمس يومي خفيف بمعامل حماية SPF50.',
  'sunscreen, spf50, korean', 'واقي شمس, حماية', 'TEST/SAMPLE — delete before real data');

-- 8) Pure Seoul — Makeup
INSERT INTO products (sku, barcode, name_en, name_ar, brand_id, main_category, sub_category, product_type, color, size, price, discount_price, cost, stock_quantity, stock_status, platform_status, image_filename, image_url, description_en, description_ar, keywords_en, keywords_ar, notes)
VALUES ('TEST-PURESEOUL-LIPMASK', '0000000000018', 'Pure Seoul Overnight Lip Mask', 'بيور سيول ماسك الشفاه الليلي',
  (SELECT id FROM brands WHERE name ILIKE '%seoul%' ORDER BY name LIMIT 1),
  'Makeup', 'Lips', 'Lip Mask', 'Berry', '20 g', 48.00, 39.00, 22.00, 22, 'In Stock', 'Published',
  'pureseoul-lipmask.jpg', 'https://example.com/pureseoul-lipmask.jpg',
  'Nourishing overnight lip mask with berry extract.', 'ماسك شفاه ليلي مغذٍّ بخلاصة التوت.',
  'lip mask, overnight, korean', 'ماسك شفاه, ليلي', 'TEST/SAMPLE — delete before real data');

-- ---------------------------------------------------------------------------
-- VARIANTS — product #1 (Rhode Peptide Lip Tint): Toast / Ribbon / Raspberry Jelly
-- ---------------------------------------------------------------------------
INSERT INTO product_variants (parent_product_id, variant_name, sku, color, size, price, stock_quantity)
VALUES
  ((SELECT id FROM products WHERE sku='TEST-RHODE-LIPTINT'), 'Toast',          'TEST-RHODE-LIPTINT-TOAST',  'Toast',          '10 ml', 75.00, 14),
  ((SELECT id FROM products WHERE sku='TEST-RHODE-LIPTINT'), 'Ribbon',         'TEST-RHODE-LIPTINT-RIBBON', 'Ribbon',         '10 ml', 75.00, 13),
  ((SELECT id FROM products WHERE sku='TEST-RHODE-LIPTINT'), 'Raspberry Jelly','TEST-RHODE-LIPTINT-RASP',   'Raspberry Jelly','10 ml', 75.00, 13);

-- ---------------------------------------------------------------------------
-- INVENTORY — one row per product (single source of stock truth).
-- One LOW row (Beautyblender 3<=5) to exercise the low-stock filter/alerts.
-- sold_quantity varies to populate the Top Products panel.
-- ---------------------------------------------------------------------------
INSERT INTO inventory (product_id, stock_quantity, low_stock_threshold, sold_quantity)
SELECT p.id, d.stock, d.threshold, d.sold
FROM products p
JOIN (VALUES
  ('TEST-RHODE-LIPTINT',       40, 10, 25),
  ('TEST-COSRX-SNAIL',         25,  5, 12),
  ('TEST-BEAUTYBLENDER',        3,  5,  8),
  ('TEST-MALIKA-GIFTSET',      15,  5,  3),
  ('TEST-THAI-INHALER',       200, 20, 40),
  ('TEST-PURESEOUL-CLEANSER',  30,  5, 18),
  ('TEST-PURESEOUL-SUNSCREEN', 18,  5,  9),
  ('TEST-PURESEOUL-LIPMASK',   22,  5, 14)
) AS d(sku, stock, threshold, sold) ON p.sku = d.sku;

-- ---------------------------------------------------------------------------
-- CHANNEL LISTINGS (optional, for a populated Channels matrix).
-- Links every TEST product to any channel whose name matches the pattern.
-- channel_stock is ALWAYS NULL: all channels share ONE inventory pool, so the
-- inventory table is the only source of stock truth (no per-channel stock).
-- Safe to comment out if you'd rather start the matrix empty.
-- ---------------------------------------------------------------------------
INSERT INTO channel_products (channel_id, product_id, channel_status, channel_price, channel_stock)
SELECT c.id, p.id, 'Active', p.price, NULL
FROM products p JOIN channels c ON c.name ILIKE '%shopify%'
WHERE p.sku LIKE 'TEST-%';

INSERT INTO channel_products (channel_id, product_id, channel_status, channel_price, channel_stock)
SELECT c.id, p.id, 'Draft', p.price, NULL
FROM products p JOIN channels c ON c.name ILIKE '%snoonu%'
WHERE p.sku LIKE 'TEST-%';

COMMIT;

-- Quick check:
--   SELECT sku, name_en, main_category FROM products WHERE sku LIKE 'TEST-%' ORDER BY sku;
