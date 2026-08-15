-- ============================================================================
-- Manual Authority Resolution (after Production Reconciliation, before INV.6) —
-- ONE-TIME DATA REPAIR of the single remaining malformed authoritative variant.
--
-- After the production reconciliation, exactly one dirty product remained: the
-- variant mk1550-1-bend-soft-peachy-beige had stock_quantity = NULL, which is a
-- non-inferable malformed authority and was deliberately left as a MANUAL blocker
-- (never guessed). The operator has now explicitly authorized normalizing that
-- NULL to 1 under the business's BINARY availability semantics (In Stock /
-- Out of Stock) — this is an operator-authorized normalization, NOT a physical
-- inventory count.
--
-- WHAT IT REPAIRS (exact, single target):
--   • product_variants.stock_quantity of 9c44f181… : NULL → 1
--   • inventory.stock_quantity of the parent (fb3b1750…) : recomputed = Σ variants (→ 4)
--
-- The whole body runs in ONE transaction inside a DO block; ANY precondition /
-- rowcount / postcondition mismatch RAISES and rolls back every change.
--
-- The ONLY tables/columns it may change:
--   product_variants.stock_quantity (the one target row only),
--   inventory.stock_quantity (the one parent row only),
--   and INSERTs into malak_audit.
--
-- It NEVER touches: inventory.sold_quantity, products.stock_quantity (retired
-- mirror), products.stock_status / product_variants.stock_status (availability),
-- shelf_stock, variant_shelf_stock, Shopify/Talabat ledgers or channel mappings.
-- It does NOT create/replace any RPC and does NOT weaken inv_set_variant_absolute
-- (whose fail-closed NULL rejection stays intact). No OOS/restock tasks — this is
-- data correction, not a business stock movement.
-- ============================================================================

DO $$
DECLARE
  v_rows          integer;
  v_sib_bad       integer;
  v_parent_total  bigint;
  v_product uuid  := 'ce9f4962-716a-4acc-af90-62b8506ef298';
  v_variant uuid  := '9c44f181-a263-4b2f-bb7f-6780f0773c18';
  v_parent_inv uuid := 'fb3b1750-cb6d-4d0a-97d4-3654ba10cbe2';
  v_count integer := 1;   -- operator-authorized normalization value (binary availability)
  v_agent text    := 'system:manual-authority-resolution';
  v_mig text      := '20260815150000_inventory_manual_authority_resolution';
BEGIN
  -- ══ PASS 1 — VALIDATE + LOCK + VERIFY EXACT PRECONDITIONS (no writes) ══════

  -- Authorized value must be a non-negative integer (defensive; literal is 1).
  IF v_count IS NULL OR v_count < 0 THEN
    RAISE EXCEPTION 'precondition: operator-authorized value must be a non-negative integer, got %', v_count;
  END IF;

  -- Deterministic locks: all variants of the product (stable order), then parent.
  PERFORM 1 FROM product_variants WHERE parent_product_id = v_product ORDER BY id FOR UPDATE;
  PERFORM 1 FROM inventory WHERE id = v_parent_inv ORDER BY id FOR UPDATE;

  -- Target product + variant exist, variant belongs to product, stock IS NULL.
  IF (SELECT count(*) FROM products WHERE id = v_product) <> 1 THEN
    RAISE EXCEPTION 'precondition: target product missing'; END IF;
  IF (SELECT count(*) FROM product_variants
        WHERE id = v_variant AND parent_product_id = v_product AND stock_quantity IS NULL) <> 1 THEN
    RAISE EXCEPTION 'precondition: target variant not found / not NULL / wrong parent'; END IF;

  -- Target variant has zero variant shelf rows.
  IF EXISTS (SELECT 1 FROM variant_shelf_stock WHERE variant_id = v_variant) THEN
    RAISE EXCEPTION 'precondition: target variant unexpectedly has shelf rows'; END IF;

  -- Exactly one parent inventory row, matching id, stock=1, sold=0.
  IF (SELECT count(*) FROM inventory WHERE product_id = v_product) <> 1 THEN
    RAISE EXCEPTION 'precondition: parent must have exactly one inventory row'; END IF;
  IF (SELECT count(*) FROM inventory
        WHERE id = v_parent_inv AND product_id = v_product AND stock_quantity = 1 AND sold_quantity = 0) <> 1 THEN
    RAISE EXCEPTION 'precondition: parent inventory id/stock/sold mismatch'; END IF;

  -- No product-level shelf rows on the parent.
  IF EXISTS (SELECT 1 FROM shelf_stock WHERE inventory_id = v_parent_inv) THEN
    RAISE EXCEPTION 'precondition: parent unexpectedly has product-level shelf rows'; END IF;

  -- All OTHER sibling variants are non-null, integer, >= 0.
  SELECT count(*) INTO v_sib_bad FROM product_variants
    WHERE parent_product_id = v_product AND id <> v_variant
      AND (stock_quantity IS NULL OR stock_quantity < 0 OR stock_quantity <> floor(stock_quantity));
  IF v_sib_bad <> 0 THEN
    RAISE EXCEPTION 'precondition: % malformed sibling variant(s)', v_sib_bad; END IF;

  -- The currently expected siblings are still exactly 1 each.
  IF (SELECT count(*) FROM product_variants WHERE id IN (
        '22e4ce0d-6742-46d8-bd76-1ab93fd77d0d',
        '4b6fe332-aa21-4d42-9206-922c9aec329e',
        '12e88474-1f75-45a0-a344-9d668e6ecd6a')
      AND parent_product_id = v_product AND stock_quantity = 1) <> 3 THEN
    RAISE EXCEPTION 'precondition: expected siblings (1,1,1) changed'; END IF;

  -- Product has exactly 4 variants total (target + 3 siblings).
  IF (SELECT count(*) FROM product_variants WHERE parent_product_id = v_product) <> 4 THEN
    RAISE EXCEPTION 'precondition: unexpected variant count for product'; END IF;

  -- Final parent total computed in bigint; ensure int4-safe.
  SELECT v_count::bigint + coalesce(sum(stock_quantity), 0)::bigint
    INTO v_parent_total
    FROM product_variants
   WHERE parent_product_id = v_product AND id <> v_variant;
  IF v_parent_total > 2147483647 THEN
    RAISE EXCEPTION 'precondition: parent total % exceeds int4 range', v_parent_total; END IF;
  IF v_parent_total <> 4 THEN
    RAISE EXCEPTION 'precondition: expected parent total 4, computed %', v_parent_total; END IF;

  -- ══ PASS 2 — APPLY + AUDIT (rowcount-checked) ═════════════════════════════

  -- 1) Target variant authority: NULL → operator-authorized value.
  -- (product_variants has no updated_at column; stock_quantity is the only write.)
  UPDATE product_variants SET stock_quantity = v_count
   WHERE id = v_variant AND parent_product_id = v_product AND stock_quantity IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN RAISE EXCEPTION 'apply target variant rowcount %', v_rows; END IF;

  INSERT INTO malak_audit (action_type, agent, sku, product_id, field, old_value, new_value, details, status)
  VALUES ('inventory_manual_authority', v_agent, null, v_product, 'variant_stock_quantity', null, v_count::text,
          jsonb_build_object('source','operator_authorized_normalization',
                             'reason','resolve_null_authoritative_variant',
                             'authorityMode','binary_in_stock_out_of_stock',
                             'operatorAuthorizedValue',v_count,
                             'variantId',v_variant,'productId',v_product,
                             'migration',v_mig,'immutable',true), 'done');

  -- 2) Parent inventory rollup: recompute = Σ variants (now 4). sold untouched.
  UPDATE inventory SET stock_quantity = v_parent_total, updated_at = now()
   WHERE id = v_parent_inv AND stock_quantity = 1;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN RAISE EXCEPTION 'apply parent rollup rowcount %', v_rows; END IF;

  INSERT INTO malak_audit (action_type, agent, sku, product_id, field, old_value, new_value, details, status)
  VALUES ('inventory_manual_authority', v_agent, null, v_product, 'stock_quantity', '1', v_parent_total::text,
          jsonb_build_object('source','operator_authorized_normalization',
                             'reason','parent_rollup_after_manual_authority',
                             'authorityMode','binary_in_stock_out_of_stock',
                             'inventoryId',v_parent_inv,'productId',v_product,
                             'migration',v_mig,'immutable',true), 'done');

  -- ══ INTERNAL POSTCONDITIONS (before commit) ═══════════════════════════════
  IF (SELECT stock_quantity FROM product_variants WHERE id = v_variant) <> v_count THEN
    RAISE EXCEPTION 'postcondition: target variant stock <> %', v_count; END IF;

  IF EXISTS (SELECT 1 FROM product_variants
               WHERE parent_product_id = v_product
                 AND (stock_quantity IS NULL OR stock_quantity < 0 OR stock_quantity <> floor(stock_quantity))) THEN
    RAISE EXCEPTION 'postcondition: a variant is still malformed'; END IF;

  IF (SELECT stock_quantity FROM inventory WHERE id = v_parent_inv)
     <> (SELECT sum(stock_quantity) FROM product_variants WHERE parent_product_id = v_product) THEN
    RAISE EXCEPTION 'postcondition: parent stock <> Σ variants'; END IF;

  IF (SELECT sold_quantity FROM inventory WHERE id = v_parent_inv) <> 0 THEN
    RAISE EXCEPTION 'postcondition: parent sold_quantity changed'; END IF;

  IF EXISTS (SELECT 1 FROM shelf_stock WHERE inventory_id = v_parent_inv) THEN
    RAISE EXCEPTION 'postcondition: parent shelf rows appeared'; END IF;
  IF EXISTS (SELECT 1 FROM variant_shelf_stock WHERE variant_id = v_variant) THEN
    RAISE EXCEPTION 'postcondition: target variant shelf rows appeared'; END IF;

  RAISE NOTICE 'manual authority resolved: variant % NULL -> %, parent % -> %', v_variant, v_count, v_parent_inv, v_parent_total;
END $$;
