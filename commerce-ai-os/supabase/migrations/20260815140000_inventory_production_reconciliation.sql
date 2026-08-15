-- ============================================================================
-- Production Reconciliation (after INV.5, before INV.6) — ONE-TIME DATA REPAIR.
--
-- Repairs the 15 deterministic, safely-repairable drift instances found by the
-- read-only reconciliation scan of production (vqstcmattiarhblqshvb), and NOTHING
-- else. It is intentional data repair, not a schema change and not a persistent
-- RPC. The whole body runs in ONE transaction (the migration transaction) inside
-- a DO block; ANY precondition/rowcount/postcondition mismatch RAISES and rolls
-- back every change — all-or-nothing.
--
-- WHAT IT REPAIRS (exact targets, verified read-only before authoring):
--   • 9 simple-product shelf rows  → shelf.quantity = authoritative inventory stock (1)
--   • 3 variant shelf rows (parent c1a1…) → shelf.quantity = authoritative variant stock (13/16/12)
--   • 2 parent inventory rollups   → inventory.stock_quantity = Σ variants (41, 14)
--   • 1 stale variant-parent location (15acc…) → inventory.location = NULL (stock 100 preserved)
--
-- The ONLY tables/columns it may change:
--   shelf_stock.quantity, variant_shelf_stock.quantity,
--   inventory.stock_quantity, inventory.location, and INSERTs into malak_audit.
--
-- It NEVER touches: products.stock_quantity (retired mirror), stock_status
-- (availability), inventory.sold_quantity, product/variant stock authority
-- (variant.stock_quantity, simple inventory.stock_quantity are AUTHORITY and are
-- read, never guessed), sales ledgers, Shopify/Talabat order tables, or the
-- NULL-stock manual blocker variant (mk1550-1-bend-soft-peachy-beige). No stock
-- tasks / OOS-restock transitions — this is correction, not a business movement.
-- ============================================================================

DO $$
DECLARE
  v_n     integer;
  v_rows  integer;
  r       record;
  v_agent text := 'system:production-reconciliation';
  v_mig   text := '20260815140000_inventory_production_reconciliation';
BEGIN
  -- ══ Target snapshots (id, ...) as inline VALUES ═══════════════════════════
  -- 9 simple shelf rows: (shelf_id, inventory_id, product_id, location, old_qty).
  CREATE TEMP TABLE _simple_shelf (shelf_id uuid, inv_id uuid, pid uuid, loc text, old_qty int) ON COMMIT DROP;
  INSERT INTO _simple_shelf VALUES
    ('18e730b8-d77f-4bef-ab72-6fc6f7772918','64fa5be2-b9ba-4673-bcbf-ac828384d7a5','0cef41c0-60c9-4c75-9b36-b2368eacfaca','A2',10),
    ('2353c9fd-2f23-46c2-8808-0e4cb4c029f4','67f176c6-5401-485a-b841-abb74e603289','1526c496-04ae-4702-a9bd-1a7b5366830a','A2',49),
    ('a69fad2b-3052-4bad-8999-e0f25a69ed69','432a989c-fe63-4dba-886a-3fc8dc84bdc2','78c092b4-c85c-4d89-b9c1-2c55b029fd07','A2',10),
    ('839706f1-c2ea-4c9d-a829-89f22d752cba','79175ebc-0ea7-45b5-9319-9e8b50a89a50','7967dc6d-8d0a-4bf5-88d6-3bd86beedf44','A2',50),
    ('74328820-6aba-4770-ab34-b52a645e27ae','b5421fcd-79c2-4793-be5b-44ffdf7ef5e5','7aa9e99f-352f-41c8-8483-67e7025f2c7e','A3',49),
    ('2923e679-1115-4c3a-aef8-59c7eedf5f69','2722037f-41d9-4de3-8ae3-f38bc7d7d11c','befd10f1-a2e0-4796-af21-9af667758d27','A2',49),
    ('25f26720-1133-4005-aec7-05e638eb45c0','83ed4b37-624a-439f-bb5b-b1247d50a19f','cfdb6a65-7f21-4ae7-a6b5-a6e1293a6199','A1',49),
    ('2a99560c-94e9-4dca-9a32-b3430f55e8ba','f50b15c8-4b71-4e09-89a3-9e89b077afde','f2b5e7e1-0afd-42a8-a6ad-ec29b3684638','A1',50),
    ('25d87a0a-a3b1-4ca5-a1c3-a4a70aa19115','09b25dfe-742a-4dc9-80ba-455c81cc54b4','f8409af0-fb87-4c91-b946-0d1178c8654f','A1',7);

  -- 3 variant shelf rows: (shelf_id, variant_id, new_qty = variant stock, old_qty).
  CREATE TEMP TABLE _variant_shelf (shelf_id uuid, variant_id uuid, new_qty int, old_qty int) ON COMMIT DROP;
  INSERT INTO _variant_shelf VALUES
    ('5a7428c8-7e4d-4bdd-a526-8135c30232e7','0604ea25-73ea-4b0d-bf39-78f2061d2a7e',13,10),
    ('196c386d-f6a9-4cf2-9b98-5bfd20258e6b','61d9b836-1d5f-42d2-97e2-c95140de6c3b',16,10),
    ('533ef78d-bd90-43c1-812a-f7f4b004d88f','e5194b5c-9338-48a1-887e-615f4cf08d48',12,10);

  -- ══ PASS 1 — PRECONDITIONS (verify EXACT before-state; no writes yet) ══════

  -- Simple shelves: inventory row matches product + stock=1, product has NO
  -- variants, exactly one shelf row per inventory, shelf id/location/old_qty match.
  SELECT count(*) INTO v_n
    FROM _simple_shelf t
    JOIN inventory i   ON i.id = t.inv_id AND i.product_id = t.pid AND i.stock_quantity = 1
    JOIN shelf_stock s ON s.id = t.shelf_id AND s.inventory_id = t.inv_id AND s.location = t.loc AND s.quantity = t.old_qty
   WHERE NOT EXISTS (SELECT 1 FROM product_variants pv WHERE pv.parent_product_id = t.pid)
     AND (SELECT count(*) FROM shelf_stock s2 WHERE s2.inventory_id = t.inv_id) = 1;
  IF v_n <> 9 THEN RAISE EXCEPTION 'precondition simple_shelf: expected 9 matched, got %', v_n; END IF;

  -- Variant shelves: parent c1a1 has exactly one inventory, no product-level shelf
  -- rows, all siblings non-null/non-negative, Σ variants = 41, parent stock = 1;
  -- each target variant belongs to the parent with the expected stock, exactly one
  -- variant shelf row, matching id/old_qty.
  IF (SELECT count(*) FROM inventory WHERE product_id = 'c1a1d62e-f60a-494f-8ca5-81d03ae44e7e') <> 1
     OR (SELECT stock_quantity FROM inventory WHERE product_id = 'c1a1d62e-f60a-494f-8ca5-81d03ae44e7e') <> 1
     OR EXISTS (SELECT 1 FROM shelf_stock s JOIN inventory i ON i.id = s.inventory_id WHERE i.product_id = 'c1a1d62e-f60a-494f-8ca5-81d03ae44e7e')
     OR EXISTS (SELECT 1 FROM product_variants WHERE parent_product_id = 'c1a1d62e-f60a-494f-8ca5-81d03ae44e7e' AND (stock_quantity IS NULL OR stock_quantity < 0))
     OR (SELECT coalesce(sum(stock_quantity),0) FROM product_variants WHERE parent_product_id = 'c1a1d62e-f60a-494f-8ca5-81d03ae44e7e') <> 41
  THEN RAISE EXCEPTION 'precondition c1a1 parent structure mismatch'; END IF;

  SELECT count(*) INTO v_n
    FROM _variant_shelf t
    JOIN product_variants pv ON pv.id = t.variant_id
      AND pv.parent_product_id = 'c1a1d62e-f60a-494f-8ca5-81d03ae44e7e'
      AND pv.stock_quantity = t.new_qty
    JOIN variant_shelf_stock vss ON vss.id = t.shelf_id AND vss.variant_id = t.variant_id AND vss.quantity = t.old_qty
   WHERE (SELECT count(*) FROM variant_shelf_stock v2 WHERE v2.variant_id = t.variant_id) = 1;
  IF v_n <> 3 THEN RAISE EXCEPTION 'precondition variant_shelf: expected 3 matched, got %', v_n; END IF;

  -- Second parent rollup c550: exactly one inventory, stock=1, no product shelves,
  -- no malformed siblings, Σ variants = 14.
  IF (SELECT count(*) FROM inventory WHERE product_id = 'c5502e6b-a144-4873-98cc-85d3dab146ea') <> 1
     OR (SELECT stock_quantity FROM inventory WHERE product_id = 'c5502e6b-a144-4873-98cc-85d3dab146ea') <> 1
     OR EXISTS (SELECT 1 FROM shelf_stock s JOIN inventory i ON i.id = s.inventory_id WHERE i.product_id = 'c5502e6b-a144-4873-98cc-85d3dab146ea')
     OR EXISTS (SELECT 1 FROM product_variants WHERE parent_product_id = 'c5502e6b-a144-4873-98cc-85d3dab146ea' AND (stock_quantity IS NULL OR stock_quantity < 0))
     OR (SELECT coalesce(sum(stock_quantity),0) FROM product_variants WHERE parent_product_id = 'c5502e6b-a144-4873-98cc-85d3dab146ea') <> 14
  THEN RAISE EXCEPTION 'precondition c550 parent structure mismatch'; END IF;

  -- Stale variant-parent location 15acc: one inventory, stock=100, location='A2',
  -- 10 variants, Σ variants = 100, no product-level shelves.
  IF (SELECT count(*) FROM inventory WHERE id = 'b3f6bb47-c6c2-4b14-8dfb-8bb18d77bd22' AND product_id = '15acc3d0-6645-4a75-ab6d-38f22db42ea4' AND stock_quantity = 100 AND location = 'A2') <> 1
     OR (SELECT count(*) FROM product_variants WHERE parent_product_id = '15acc3d0-6645-4a75-ab6d-38f22db42ea4') <> 10
     OR (SELECT coalesce(sum(stock_quantity),0) FROM product_variants WHERE parent_product_id = '15acc3d0-6645-4a75-ab6d-38f22db42ea4') <> 100
     OR EXISTS (SELECT 1 FROM shelf_stock WHERE inventory_id = 'b3f6bb47-c6c2-4b14-8dfb-8bb18d77bd22')
  THEN RAISE EXCEPTION 'precondition 15acc stale-location structure mismatch'; END IF;

  -- ══ Deterministic locks (stable order) ════════════════════════════════════
  PERFORM 1 FROM inventory
   WHERE id IN ('451b8698-bc32-42d4-9043-cac78fbe2342','3e86f7ed-2933-47f7-94f1-93b12406713a','b3f6bb47-c6c2-4b14-8dfb-8bb18d77bd22')
      OR id IN (SELECT inv_id FROM _simple_shelf)
   ORDER BY id FOR UPDATE;
  PERFORM 1 FROM shelf_stock WHERE id IN (SELECT shelf_id FROM _simple_shelf) ORDER BY id FOR UPDATE;
  PERFORM 1 FROM variant_shelf_stock WHERE id IN (SELECT shelf_id FROM _variant_shelf) ORDER BY variant_id, id FOR UPDATE;

  -- ══ PASS 2 — APPLY + AUDIT (rowcount-checked) ═════════════════════════════

  -- 1) simple shelf rows → authoritative inventory stock (1). Audit each.
  FOR r IN SELECT shelf_id, inv_id, pid, old_qty FROM _simple_shelf ORDER BY shelf_id LOOP
    UPDATE shelf_stock SET quantity = 1, updated_at = now() WHERE id = r.shelf_id;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN RAISE EXCEPTION 'apply simple_shelf rowcount % for %', v_rows, r.shelf_id; END IF;
    INSERT INTO malak_audit (action_type, agent, sku, product_id, field, old_value, new_value, details, status)
    VALUES ('inventory_reconcile', v_agent, null, r.pid, 'shelf_stock.quantity', r.old_qty::text, '1',
            jsonb_build_object('source','production_reconciliation','reason','simple_shelf_drift',
                               'authoritativeSource','inventory','migration',v_mig,
                               'shelfId',r.shelf_id,'inventoryId',r.inv_id,'immutable',true), 'done');
  END LOOP;

  -- 2) variant shelf rows → authoritative variant stock. Audit each.
  FOR r IN SELECT shelf_id, variant_id, new_qty, old_qty FROM _variant_shelf ORDER BY variant_id, shelf_id LOOP
    UPDATE variant_shelf_stock SET quantity = r.new_qty, updated_at = now() WHERE id = r.shelf_id;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN RAISE EXCEPTION 'apply variant_shelf rowcount % for %', v_rows, r.shelf_id; END IF;
    INSERT INTO malak_audit (action_type, agent, sku, product_id, field, old_value, new_value, details, status)
    VALUES ('inventory_reconcile', v_agent, null, 'c1a1d62e-f60a-494f-8ca5-81d03ae44e7e', 'variant_shelf_stock.quantity', r.old_qty::text, r.new_qty::text,
            jsonb_build_object('source','production_reconciliation','reason','variant_shelf_drift',
                               'authoritativeSource','variant','migration',v_mig,
                               'shelfId',r.shelf_id,'variantId',r.variant_id,'immutable',true), 'done');
  END LOOP;

  -- 3) parent rollups → inventory.stock_quantity = Σ variants. Audit each.
  UPDATE inventory SET stock_quantity = 41, updated_at = now()
   WHERE id = '451b8698-bc32-42d4-9043-cac78fbe2342' AND stock_quantity = 1;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN RAISE EXCEPTION 'apply c1a1 rollup rowcount %', v_rows; END IF;
  INSERT INTO malak_audit (action_type, agent, sku, product_id, field, old_value, new_value, details, status)
  VALUES ('inventory_reconcile', v_agent, null, 'c1a1d62e-f60a-494f-8ca5-81d03ae44e7e', 'stock_quantity', '1', '41',
          jsonb_build_object('source','production_reconciliation','reason','parent_rollup_drift',
                             'authoritativeSource','variant_sum','migration',v_mig,
                             'inventoryId','451b8698-bc32-42d4-9043-cac78fbe2342','immutable',true), 'done');

  UPDATE inventory SET stock_quantity = 14, updated_at = now()
   WHERE id = '3e86f7ed-2933-47f7-94f1-93b12406713a' AND stock_quantity = 1;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN RAISE EXCEPTION 'apply c550 rollup rowcount %', v_rows; END IF;
  INSERT INTO malak_audit (action_type, agent, sku, product_id, field, old_value, new_value, details, status)
  VALUES ('inventory_reconcile', v_agent, null, 'c5502e6b-a144-4873-98cc-85d3dab146ea', 'stock_quantity', '1', '14',
          jsonb_build_object('source','production_reconciliation','reason','parent_rollup_drift',
                             'authoritativeSource','variant_sum','migration',v_mig,
                             'inventoryId','3e86f7ed-2933-47f7-94f1-93b12406713a','immutable',true), 'done');

  -- 4) stale variant-parent location → NULL (stock preserved). Audit.
  UPDATE inventory SET location = NULL, updated_at = now()
   WHERE id = 'b3f6bb47-c6c2-4b14-8dfb-8bb18d77bd22' AND location = 'A2' AND stock_quantity = 100;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN RAISE EXCEPTION 'apply 15acc location rowcount %', v_rows; END IF;
  INSERT INTO malak_audit (action_type, agent, sku, product_id, field, old_value, new_value, details, status)
  VALUES ('inventory_reconcile', v_agent, null, '15acc3d0-6645-4a75-ab6d-38f22db42ea4', 'location', 'A2', null,
          jsonb_build_object('source','production_reconciliation','reason','stale_location_without_shelf',
                             'authoritativeSource','inventory','migration',v_mig,
                             'inventoryId','b3f6bb47-c6c2-4b14-8dfb-8bb18d77bd22','immutable',true), 'done');

  -- ══ INTERNAL POSTCONDITIONS (before commit) ═══════════════════════════════
  -- All 9 simple shelves now equal their inventory stock.
  SELECT count(*) INTO v_n FROM _simple_shelf t
    JOIN shelf_stock s ON s.id = t.shelf_id
    JOIN inventory i ON i.id = t.inv_id
   WHERE s.quantity = i.stock_quantity;
  IF v_n <> 9 THEN RAISE EXCEPTION 'postcondition simple_shelf: % of 9', v_n; END IF;

  -- All 3 variant shelves now equal their variant stock.
  SELECT count(*) INTO v_n FROM _variant_shelf t
    JOIN variant_shelf_stock vss ON vss.id = t.shelf_id
    JOIN product_variants pv ON pv.id = t.variant_id
   WHERE vss.quantity = pv.stock_quantity;
  IF v_n <> 3 THEN RAISE EXCEPTION 'postcondition variant_shelf: % of 3', v_n; END IF;

  IF (SELECT stock_quantity FROM inventory WHERE id = '451b8698-bc32-42d4-9043-cac78fbe2342') <> 41 THEN RAISE EXCEPTION 'postcondition c1a1 parent <> 41'; END IF;
  IF (SELECT stock_quantity FROM inventory WHERE id = '3e86f7ed-2933-47f7-94f1-93b12406713a') <> 14 THEN RAISE EXCEPTION 'postcondition c550 parent <> 14'; END IF;
  IF (SELECT location FROM inventory WHERE id = 'b3f6bb47-c6c2-4b14-8dfb-8bb18d77bd22') IS NOT NULL THEN RAISE EXCEPTION 'postcondition 15acc location not null'; END IF;
  IF (SELECT stock_quantity FROM inventory WHERE id = 'b3f6bb47-c6c2-4b14-8dfb-8bb18d77bd22') <> 100 THEN RAISE EXCEPTION 'postcondition 15acc stock changed'; END IF;
  IF (SELECT coalesce(sum(stock_quantity),0) FROM product_variants WHERE parent_product_id = '15acc3d0-6645-4a75-ab6d-38f22db42ea4') <> 100 THEN RAISE EXCEPTION 'postcondition 15acc Σ variants <> 100'; END IF;

  RAISE NOTICE 'production reconciliation applied: 9 simple shelves, 3 variant shelves, 2 parent rollups, 1 stale location';
END $$;
