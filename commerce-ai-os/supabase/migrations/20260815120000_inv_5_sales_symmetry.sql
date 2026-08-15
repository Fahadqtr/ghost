-- ============================================================================
-- INV.5 — Unified Sales Engine + Shopify/Talabat symmetry.
--
-- One canonical, grain-aware SALE primitive that BOTH sales channels and the
-- Inventory Engine's sell() route through, so a Shopify sale, a Talabat sale, and
-- an Engine sell() apply IDENTICAL semantics:
--
--   SIMPLE   → inventory.stock_quantity is authoritative.
--   VARIANT  → product_variants.stock_quantity is authoritative; the parent
--              inventory.stock_quantity = Σ variants (never max, never a mirror).
--   SHELVES  → shelf tables are the authoritative distribution overlay; a sale
--              spreads biggest-first, deletes emptied placements, recomputes the
--              primary location, and the Σ must still equal the authoritative stock.
--   SALE     → stock decreases, inventory.sold_quantity increases (per PARENT,
--              aggregated once even when several variants of one parent sell).
--
-- products.stock_quantity is RETIRED (INV.4E) — never written, never read as
-- authority. Availability (stock_status) is fully independent — a 0 quantity after
-- a sale does NOT imply unavailable, and nothing here reads/writes stock_status.
--
-- Layout:
--   1) inv_apply_sale_targets(p_targets, p_source, p_external_id)  — INTERNAL
--      canonical primitive. Grain-aware PASS 1 (validate + lock, no writes) then
--      PASS 2 (apply everything or nothing in a subtransaction). Writes one
--      malak_audit stock_out row per affected grain (immutable:true). Returns a
--      canonical {status, deductedUnits, products[], variants[]} or a classified
--      {status:'error', reason}. Callable ONLY by the SECURITY DEFINER wrappers
--      below (revoked from public/anon/authenticated/service_role).
--   2) inv_sell(p_scope, p_target_id, p_quantity, p_source, p_external_id)  —
--      service-role RPC; converts a single target to a canonical target array and
--      calls the primitive.
--   3) process_shopify_order_deduction(...)  — CREATE OR REPLACE; now grain-aware
--      (p_deductions carry productId + variantId), advisory-locked idempotency,
--      NO pre-claim (the completed ledger row is written only after a successful
--      sale), fail-closed on a classified sale failure (nothing recorded).
--   4) process_talabat_order_deduction(...)  — CREATE OR REPLACE; SAME signature,
--      SAME dedup / safe-resolution / manual_review behavior, but the numeric sale
--      is delegated to inv_apply_sale_targets (resolves masterVariantSku → variant
--      id first). Success now returns deductedUnits/products/variants too.
--
-- 2147483647 = max int4. malak_audit is this project's stock-movement ledger.
-- ============================================================================

-- ============================================================================
-- 1) inv_apply_sale_targets — INTERNAL canonical sale primitive.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.inv_apply_sale_targets(
  p_targets     jsonb,
  p_source      text,
  p_external_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uuid_re    text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_agg        jsonb;
  v_t          jsonb;
  v_pid        uuid;
  v_vid        uuid;
  v_qty        integer;
  v_cnt        integer;
  v_inv_id     uuid;
  v_avail_raw  integer;
  v_avail      integer;
  v_sold_before integer;
  v_shelf_sum  integer;
  v_prod       record;
  v_before     integer;
  v_after      integer;
  v_sum        integer;
  v_rem        integer;
  v_rows       integer;
  v_deducted   bigint := 0;
  v_products   jsonb := '[]'::jsonb;
  v_variants   jsonb := '[]'::jsonb;
  v_vsku       text;
  v_loc        text;
  r            record;
BEGIN
  IF p_source IS NULL OR btrim(p_source) = '' THEN
    RETURN jsonb_build_object('status', 'error', 'reason', 'invalid_source');
  END IF;
  IF p_targets IS NULL OR jsonb_typeof(p_targets) <> 'array' OR jsonb_array_length(p_targets) = 0 THEN
    RETURN jsonb_build_object('status', 'error', 'reason', 'invalid_plan');
  END IF;

  -- ── PASS 0: strict shape validation (staged; no cast shares a guard) ────────
  FOR v_t IN SELECT * FROM jsonb_array_elements(p_targets) LOOP
    IF (v_t ->> 'productId') IS NULL OR (v_t ->> 'productId') !~ v_uuid_re THEN
      RETURN jsonb_build_object('status', 'error', 'reason', 'invalid_plan');
    END IF;
    IF NOT (jsonb_typeof(v_t -> 'variantId') = 'null'
            OR ((v_t ->> 'variantId') IS NOT NULL AND (v_t ->> 'variantId') ~ v_uuid_re)) THEN
      RETURN jsonb_build_object('status', 'error', 'reason', 'invalid_plan');
    END IF;
    IF jsonb_typeof(v_t -> 'quantity') <> 'number' THEN
      RETURN jsonb_build_object('status', 'error', 'reason', 'invalid_plan');
    END IF;
    IF (v_t ->> 'quantity') !~ '^[1-9][0-9]*$' THEN
      RETURN jsonb_build_object('status', 'error', 'reason', 'invalid_plan');
    END IF;
    IF (v_t ->> 'quantity')::bigint > 2147483647 THEN
      RETURN jsonb_build_object('status', 'error', 'reason', 'invalid_plan');
    END IF;
  END LOOP;

  -- Aggregate duplicate targets per (productId, variantId) in BIGINT; reject
  -- aggregate overflow. Deterministic order: productId ASC, then variantId with
  -- NULLS FIRST — a globally stable lock sequence.
  IF EXISTS (
    SELECT 1 FROM (
      SELECT sum((t ->> 'quantity')::bigint) AS qsum
        FROM jsonb_array_elements(p_targets) t
       GROUP BY (t ->> 'productId'), (t ->> 'variantId')
    ) s WHERE s.qsum > 2147483647
  ) THEN
    RETURN jsonb_build_object('status', 'error', 'reason', 'invalid_plan');
  END IF;

  SELECT jsonb_agg(jsonb_build_object('productId', pid, 'variantId', vid, 'quantity', qsum)
                   ORDER BY pid, vid NULLS FIRST)
    INTO v_agg
    FROM (
      SELECT (t ->> 'productId') AS pid,
             (t ->> 'variantId') AS vid,
             sum((t ->> 'quantity')::bigint) AS qsum
        FROM jsonb_array_elements(p_targets) t
       GROUP BY 1, 2
    ) g;

  -- ── PASS 1: lock + verify every aggregated target (NO writes) ──────────────
  FOR v_t IN SELECT * FROM jsonb_array_elements(v_agg) LOOP
    v_pid := (v_t ->> 'productId')::uuid;
    v_vsku := v_t ->> 'variantId';
    v_qty := (v_t ->> 'quantity')::int;
    IF v_qty <= 0 THEN RETURN jsonb_build_object('status', 'error', 'reason', 'invalid_plan'); END IF;

    IF v_vsku IS NULL THEN
      -- SIMPLE target: product must have NO variants, exactly one inventory row.
      SELECT count(*) INTO v_cnt FROM product_variants WHERE parent_product_id = v_pid;
      IF v_cnt <> 0 THEN RETURN jsonb_build_object('status', 'error', 'reason', 'inventory_inconsistent'); END IF;
      SELECT count(*) INTO v_cnt FROM inventory WHERE product_id = v_pid;
      IF v_cnt <> 1 THEN RETURN jsonb_build_object('status', 'error', 'reason', 'inventory_inconsistent'); END IF;
      SELECT id, stock_quantity, sold_quantity INTO v_inv_id, v_avail_raw, v_sold_before
        FROM inventory WHERE product_id = v_pid FOR UPDATE;
      IF v_avail_raw IS NULL OR v_avail_raw < 0 THEN RETURN jsonb_build_object('status', 'error', 'reason', 'inventory_inconsistent'); END IF;
      IF v_sold_before IS NOT NULL AND v_sold_before < 0 THEN RETURN jsonb_build_object('status', 'error', 'reason', 'inventory_inconsistent'); END IF;
      PERFORM 1 FROM shelf_stock WHERE inventory_id = v_inv_id ORDER BY id FOR UPDATE;
      IF EXISTS (SELECT 1 FROM shelf_stock WHERE inventory_id = v_inv_id) THEN
        IF EXISTS (SELECT 1 FROM shelf_stock WHERE inventory_id = v_inv_id AND (quantity IS NULL OR quantity < 0)) THEN
          RETURN jsonb_build_object('status', 'error', 'reason', 'inventory_inconsistent');
        END IF;
        SELECT coalesce(sum(quantity), 0) INTO v_shelf_sum FROM shelf_stock WHERE inventory_id = v_inv_id;
        IF v_shelf_sum <> v_avail_raw THEN RETURN jsonb_build_object('status', 'error', 'reason', 'inventory_inconsistent'); END IF;
      END IF;
      IF v_qty > v_avail_raw THEN RETURN jsonb_build_object('status', 'error', 'reason', 'insufficient_stock'); END IF;
    ELSE
      -- VARIANT target: the variant belongs to the product; lock all siblings
      -- (sku, id) then the parent inventory row — the same deterministic sequence
      -- as the rollup dependency so concurrent variant sales serialize.
      SELECT count(*) INTO v_cnt FROM product_variants WHERE id = v_vsku::uuid AND parent_product_id = v_pid;
      IF v_cnt <> 1 THEN RETURN jsonb_build_object('status', 'error', 'reason', 'inventory_inconsistent'); END IF;
      PERFORM 1 FROM product_variants WHERE parent_product_id = v_pid ORDER BY sku, id FOR UPDATE;
      IF EXISTS (SELECT 1 FROM product_variants WHERE parent_product_id = v_pid AND (stock_quantity IS NULL OR stock_quantity < 0)) THEN
        RETURN jsonb_build_object('status', 'error', 'reason', 'inventory_inconsistent');
      END IF;
      SELECT stock_quantity INTO v_avail_raw FROM product_variants WHERE id = v_vsku::uuid;
      IF v_avail_raw IS NULL OR v_avail_raw < 0 THEN RETURN jsonb_build_object('status', 'error', 'reason', 'inventory_inconsistent'); END IF;
      SELECT count(*) INTO v_cnt FROM inventory WHERE product_id = v_pid;
      IF v_cnt <> 1 THEN RETURN jsonb_build_object('status', 'error', 'reason', 'inventory_inconsistent'); END IF;
      SELECT id, stock_quantity, sold_quantity INTO v_inv_id, v_avail, v_sold_before
        FROM inventory WHERE product_id = v_pid FOR UPDATE;
      IF v_avail IS NULL OR v_avail < 0 THEN RETURN jsonb_build_object('status', 'error', 'reason', 'inventory_inconsistent'); END IF;
      IF v_sold_before IS NOT NULL AND v_sold_before < 0 THEN RETURN jsonb_build_object('status', 'error', 'reason', 'inventory_inconsistent'); END IF;
      -- Parent must equal Σ siblings (fail-closed rollup precheck).
      SELECT coalesce(sum(stock_quantity), 0) INTO v_sum FROM product_variants WHERE parent_product_id = v_pid;
      IF v_sum <> v_avail THEN RETURN jsonb_build_object('status', 'error', 'reason', 'inventory_inconsistent'); END IF;
      -- A variant product must NOT carry product-level shelf rows.
      IF EXISTS (SELECT 1 FROM shelf_stock WHERE inventory_id = v_inv_id) THEN
        RETURN jsonb_build_object('status', 'error', 'reason', 'parent_has_shelf_rows');
      END IF;
      PERFORM 1 FROM variant_shelf_stock WHERE variant_id = v_vsku::uuid ORDER BY id FOR UPDATE;
      IF EXISTS (SELECT 1 FROM variant_shelf_stock WHERE variant_id = v_vsku::uuid) THEN
        IF EXISTS (SELECT 1 FROM variant_shelf_stock WHERE variant_id = v_vsku::uuid AND (quantity IS NULL OR quantity < 0)) THEN
          RETURN jsonb_build_object('status', 'error', 'reason', 'inventory_inconsistent');
        END IF;
        SELECT coalesce(sum(quantity), 0) INTO v_shelf_sum FROM variant_shelf_stock WHERE variant_id = v_vsku::uuid;
        IF v_shelf_sum <> v_avail_raw THEN RETURN jsonb_build_object('status', 'error', 'reason', 'inventory_inconsistent'); END IF;
      END IF;
      IF v_qty > v_avail_raw THEN RETURN jsonb_build_object('status', 'error', 'reason', 'insufficient_stock'); END IF;
    END IF;
  END LOOP;

  -- ── PASS 2: apply everything or nothing (subtransaction) ───────────────────
  BEGIN
    FOR v_prod IN
      SELECT (t ->> 'productId') AS pid,
             bool_or((t ->> 'variantId') IS NOT NULL) AS has_variant,
             sum((t ->> 'quantity')::bigint) AS total_qty,
             jsonb_agg(t ORDER BY (t ->> 'variantId')) AS targets
        FROM jsonb_array_elements(v_agg) t
       GROUP BY (t ->> 'productId')
       ORDER BY (t ->> 'productId')
    LOOP
      v_pid := v_prod.pid::uuid;
      v_deducted := v_deducted + v_prod.total_qty;

      IF NOT v_prod.has_variant THEN
        -- SIMPLE sale.
        v_qty := v_prod.total_qty::int;
        SELECT id, coalesce(stock_quantity, 0), coalesce(sold_quantity, 0)
          INTO v_inv_id, v_before, v_sold_before FROM inventory WHERE product_id = v_pid;
        v_after := v_before - v_qty;
        IF v_after < 0 THEN RAISE EXCEPTION 'sale_underflow'; END IF;

        IF EXISTS (SELECT 1 FROM shelf_stock WHERE inventory_id = v_inv_id) THEN
          v_rem := v_qty;
          FOR r IN SELECT id, quantity FROM shelf_stock WHERE inventory_id = v_inv_id
                    ORDER BY quantity DESC, location ASC, id ASC LOOP
            EXIT WHEN v_rem <= 0;
            UPDATE shelf_stock SET quantity = quantity - least(quantity, v_rem), updated_at = now() WHERE id = r.id;
            GET DIAGNOSTICS v_rows = ROW_COUNT;
            IF v_rows <> 1 THEN RAISE EXCEPTION 'sale_rowcount'; END IF;
            v_rem := v_rem - least(r.quantity, v_rem);
          END LOOP;
          IF v_rem <> 0 THEN RAISE EXCEPTION 'sale_shelf_remainder'; END IF;
          -- Drop emptied placements; never keep a zero row.
          DELETE FROM shelf_stock WHERE inventory_id = v_inv_id AND quantity = 0;
          -- Primary location = largest remaining placement (tie → location ASC), else NULL.
          SELECT location INTO v_loc FROM shelf_stock WHERE inventory_id = v_inv_id
            ORDER BY quantity DESC, location ASC LIMIT 1;
          UPDATE inventory
             SET stock_quantity = v_after, location = v_loc,
                 sold_quantity = coalesce(sold_quantity, 0) + v_qty, updated_at = now()
           WHERE id = v_inv_id;
        ELSE
          UPDATE inventory
             SET stock_quantity = v_after,
                 sold_quantity = coalesce(sold_quantity, 0) + v_qty, updated_at = now()
           WHERE id = v_inv_id;
        END IF;
        GET DIAGNOSTICS v_rows = ROW_COUNT;
        IF v_rows <> 1 THEN RAISE EXCEPTION 'sale_rowcount'; END IF;

        IF coalesce(v_sold_before, 0)::bigint + v_qty > 2147483647 THEN RAISE EXCEPTION 'sale_sold_overflow'; END IF;

        INSERT INTO malak_audit (action_type, agent, sku, product_id, field, old_value, new_value, details, status)
        VALUES ('stock_out', p_source, null, v_pid, 'stock_quantity', v_before::text, v_after::text,
                jsonb_build_object('source', p_source, 'direction', 'out', 'reason', 'sale',
                                   'orderId', p_external_id, 'productId', v_pid, 'inventoryId', v_inv_id,
                                   'quantity', v_qty, 'immutable', true), 'done');

        v_products := v_products || jsonb_build_object(
          'productId', v_pid, 'inventoryId', v_inv_id, 'before', v_before, 'after', v_after,
          'soldBefore', coalesce(v_sold_before, 0), 'soldAfter', coalesce(v_sold_before, 0) + v_qty);
      ELSE
        -- VARIANT sale: apply each variant, then roll the parent up ONCE.
        FOR v_t IN SELECT * FROM jsonb_array_elements(v_prod.targets) LOOP
          v_vid := (v_t ->> 'variantId')::uuid;
          v_qty := (v_t ->> 'quantity')::int;
          SELECT coalesce(stock_quantity, 0), sku INTO v_before, v_vsku FROM product_variants WHERE id = v_vid;
          v_after := v_before - v_qty;
          IF v_after < 0 THEN RAISE EXCEPTION 'sale_underflow'; END IF;
          IF EXISTS (SELECT 1 FROM variant_shelf_stock WHERE variant_id = v_vid) THEN
            v_rem := v_qty;
            FOR r IN SELECT id, quantity FROM variant_shelf_stock WHERE variant_id = v_vid
                      ORDER BY quantity DESC, location ASC, id ASC LOOP
              EXIT WHEN v_rem <= 0;
              UPDATE variant_shelf_stock SET quantity = quantity - least(quantity, v_rem), updated_at = now() WHERE id = r.id;
              GET DIAGNOSTICS v_rows = ROW_COUNT;
              IF v_rows <> 1 THEN RAISE EXCEPTION 'sale_rowcount'; END IF;
              v_rem := v_rem - least(r.quantity, v_rem);
            END LOOP;
            IF v_rem <> 0 THEN RAISE EXCEPTION 'sale_shelf_remainder'; END IF;
            DELETE FROM variant_shelf_stock WHERE variant_id = v_vid AND quantity = 0;
          END IF;
          UPDATE product_variants SET stock_quantity = v_after WHERE id = v_vid;
          GET DIAGNOSTICS v_rows = ROW_COUNT;
          IF v_rows <> 1 THEN RAISE EXCEPTION 'sale_rowcount'; END IF;

          v_variants := v_variants || jsonb_build_object(
            'productId', v_pid, 'variantId', v_vid, 'variantSku', v_vsku, 'before', v_before, 'after', v_after);

          INSERT INTO malak_audit (action_type, agent, sku, product_id, field, old_value, new_value, details, status)
          VALUES ('stock_out', p_source, v_vsku, v_pid, 'variant_stock_quantity', v_before::text, v_after::text,
                  jsonb_build_object('source', p_source, 'direction', 'out', 'reason', 'sale',
                                     'orderId', p_external_id, 'productId', v_pid, 'variantId', v_vid,
                                     'variantSku', v_vsku, 'quantity', v_qty, 'immutable', true), 'done');
        END LOOP;

        -- Parent rollup = Σ siblings (authoritative); sold += this product's total.
        SELECT id, coalesce(sold_quantity, 0) INTO v_inv_id, v_sold_before FROM inventory WHERE product_id = v_pid;
        SELECT coalesce(sum(stock_quantity), 0) INTO v_sum FROM product_variants WHERE parent_product_id = v_pid;
        IF v_sold_before::bigint + v_prod.total_qty > 2147483647 THEN RAISE EXCEPTION 'sale_sold_overflow'; END IF;
        UPDATE inventory
           SET stock_quantity = v_sum,
               sold_quantity = coalesce(sold_quantity, 0) + v_prod.total_qty::int, updated_at = now()
         WHERE id = v_inv_id;
        GET DIAGNOSTICS v_rows = ROW_COUNT;
        IF v_rows <> 1 THEN RAISE EXCEPTION 'sale_rowcount'; END IF;

        -- Parent authoritative before/after (overall): after = Σ now; before = after + total sold.
        v_products := v_products || jsonb_build_object(
          'productId', v_pid, 'inventoryId', v_inv_id,
          'before', v_sum + v_prod.total_qty::int, 'after', v_sum,
          'soldBefore', v_sold_before, 'soldAfter', v_sold_before + v_prod.total_qty::int);
      END IF;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    -- Any PASS-2 failure rolled back every write in this subtransaction.
    RETURN jsonb_build_object('status', 'error', 'reason', 'inventory_inconsistent');
  END;

  RETURN jsonb_build_object(
    'status', 'applied',
    'deductedUnits', v_deducted,
    'products', v_products,
    'variants', v_variants
  );
END;
$$;

-- INTERNAL: only the SECURITY DEFINER wrappers (owned by the same role) call it.
REVOKE ALL ON FUNCTION public.inv_apply_sale_targets(jsonb, text, text) FROM public;
REVOKE ALL ON FUNCTION public.inv_apply_sale_targets(jsonb, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.inv_apply_sale_targets(jsonb, text, text) FROM authenticated;
REVOKE ALL ON FUNCTION public.inv_apply_sale_targets(jsonb, text, text) FROM service_role;

-- ============================================================================
-- 2) inv_sell — service-role Inventory Engine sell() entry point.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.inv_sell(
  p_scope       text,
  p_target_id   uuid,
  p_quantity    integer,
  p_source      text,
  p_external_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_targets jsonb;
BEGIN
  IF p_target_id IS NULL THEN RETURN jsonb_build_object('status', 'error', 'reason', 'invalid_plan'); END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 OR p_quantity > 2147483647 THEN
    RETURN jsonb_build_object('status', 'error', 'reason', 'invalid_plan');
  END IF;

  IF p_scope = 'product' THEN
    v_targets := jsonb_build_array(jsonb_build_object(
      'productId', p_target_id, 'variantId', null, 'quantity', p_quantity));
  ELSIF p_scope = 'variant' THEN
    -- Resolve the variant's parent so the primitive gets durable (productId, variantId).
    v_targets := (
      SELECT jsonb_build_array(jsonb_build_object(
               'productId', pv.parent_product_id, 'variantId', pv.id, 'quantity', p_quantity))
        FROM product_variants pv WHERE pv.id = p_target_id);
    IF v_targets IS NULL THEN RETURN jsonb_build_object('status', 'error', 'reason', 'inventory_inconsistent'); END IF;
  ELSE
    RETURN jsonb_build_object('status', 'error', 'reason', 'invalid_plan');
  END IF;

  RETURN public.inv_apply_sale_targets(v_targets, coalesce(nullif(p_source, ''), 'engine'), p_external_id);
END;
$$;

REVOKE ALL ON FUNCTION public.inv_sell(text, uuid, integer, text, text) FROM public;
REVOKE ALL ON FUNCTION public.inv_sell(text, uuid, integer, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.inv_sell(text, uuid, integer, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.inv_sell(text, uuid, integer, text, text) TO service_role;

-- ============================================================================
-- 3) process_shopify_order_deduction — grain-aware, delegates to the primitive.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.process_shopify_order_deduction(
  p_order_id              text,
  p_order_name            text,
  p_channel               text,
  p_payment_gateway_names jsonb,
  p_deductions            jsonb,   -- [{ "productId": uuid, "variantId": uuid|null, "quantity": int }, ...]
  p_baseline              boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_exists  boolean;
  v_res     jsonb;
  v_status  text;
  v_units   integer;
BEGIN
  IF p_order_id IS NULL OR length(p_order_id) = 0 THEN
    RETURN jsonb_build_object('status', 'error', 'reason', 'invalid_plan');
  END IF;
  IF jsonb_typeof(coalesce(p_deductions, '[]'::jsonb)) <> 'array' THEN
    RETURN jsonb_build_object('status', 'error', 'reason', 'invalid_plan');
  END IF;

  -- Serialize concurrent calls for the SAME order BEFORE any read/write, then
  -- check the ledger. No pre-claim row is ever written — the completed ledger row
  -- is inserted only after a successful (or baseline / no-op) settlement.
  PERFORM pg_advisory_xact_lock(hashtext(p_order_id));

  SELECT true INTO v_exists FROM shopify_synced_orders WHERE order_id = p_order_id;
  IF v_exists THEN
    RETURN jsonb_build_object('status', 'already_processed', 'deductedUnits', 0);
  END IF;

  -- BASELINE first run: record only, deduct nothing.
  IF coalesce(p_baseline, false) THEN
    INSERT INTO shopify_synced_orders
      (order_id, order_name, deducted, channel, payment_gateway_names, processing_status, processed_at, deduction_result)
    VALUES (p_order_id, p_order_name, 0, coalesce(nullif(p_channel, ''), 'shopify'), p_payment_gateway_names,
            'completed', now(), jsonb_build_object('status', 'baseline_recorded', 'deductedUnits', 0));
    RETURN jsonb_build_object('status', 'baseline_recorded', 'deductedUnits', 0);
  END IF;

  -- Non-sale / void order (no deductions): record completed with 0 deducted.
  IF jsonb_array_length(p_deductions) = 0 THEN
    INSERT INTO shopify_synced_orders
      (order_id, order_name, deducted, channel, payment_gateway_names, processing_status, processed_at, deduction_result)
    VALUES (p_order_id, p_order_name, 0, coalesce(nullif(p_channel, ''), 'shopify'), p_payment_gateway_names,
            'completed', now(), jsonb_build_object('status', 'processed', 'deductedUnits', 0));
    RETURN jsonb_build_object('status', 'processed', 'deductedUnits', 0, 'products', '[]'::jsonb, 'variants', '[]'::jsonb);
  END IF;

  -- SALE: the canonical primitive is the sole numeric writer + audit writer.
  v_res := public.inv_apply_sale_targets(p_deductions, coalesce(nullif(p_channel, ''), 'shopify'), p_order_id);
  v_status := v_res ->> 'status';

  IF v_status IS DISTINCT FROM 'applied' THEN
    -- Classified sale failure → record NOTHING. The order stays retryable /
    -- manual-review at the app layer; no completed ledger, no stock, no audit.
    RETURN v_res;
  END IF;

  -- Success → record the completed ledger row in the SAME transaction. If this
  -- insert fails, re-raise so the sale + audit roll back together (never a
  -- deducted-but-unrecorded order); the TS layer treats the raise as fail-closed.
  v_units := coalesce((v_res ->> 'deductedUnits')::int, 0);
  INSERT INTO shopify_synced_orders
    (order_id, order_name, deducted, channel, payment_gateway_names, processing_status, processed_at, deduction_result)
  VALUES (p_order_id, p_order_name, v_units, coalesce(nullif(p_channel, ''), 'shopify'), p_payment_gateway_names,
          'completed', now(), (v_res || jsonb_build_object('status', 'processed')));

  RETURN jsonb_build_object(
    'status', 'processed',
    'deductedUnits', v_units,
    'products', coalesce(v_res -> 'products', '[]'::jsonb),
    'variants', coalesce(v_res -> 'variants', '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.process_shopify_order_deduction(text, text, text, jsonb, jsonb, boolean) FROM public;
REVOKE ALL ON FUNCTION public.process_shopify_order_deduction(text, text, text, jsonb, jsonb, boolean) FROM anon;
REVOKE ALL ON FUNCTION public.process_shopify_order_deduction(text, text, text, jsonb, jsonb, boolean) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.process_shopify_order_deduction(text, text, text, jsonb, jsonb, boolean) TO service_role;

-- ============================================================================
-- 4) process_talabat_order_deduction — same contract; delegates numeric sale.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.process_talabat_order_deduction(
  p_order_id   uuid,
  p_dedup_key  text,
  p_plan       jsonb,
  p_resolution jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_status   text;
  v_dedup    text;
  v_fail     text := null;
  v_safe     jsonb;
  v_lines    jsonb;
  v_targets  jsonb;
  v_reasons  jsonb;
  v_ded      jsonb;
  v_msku     jsonb;
  v_pid      uuid;
  v_vsku     text;
  v_vid      uuid;
  v_cnt      integer;
  v_rows     integer;
  v_canon    jsonb := '[]'::jsonb;
  v_res      jsonb;
  v_uuid_re  text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
begin
  -- A non-empty dedup key is mandatory.
  if p_dedup_key is null or length(btrim(p_dedup_key)) = 0 then
    return jsonb_build_object('status', 'error', 'reason', 'missing_dedup_key');
  end if;

  -- DEEP, TYPE-AWARE whitelist of the resolution (unchanged from the hardened
  -- INV.3 contract — rebuilt element-by-element so no raw/PII field survives).
  select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'lineKey',  case when jsonb_typeof(e -> 'lineKey') = 'string' then e -> 'lineKey' else null end,
           'status',   case when jsonb_typeof(e -> 'status')  = 'string' then e -> 'status'  else null end,
           'via',      case when jsonb_typeof(e -> 'via')     = 'string' then e -> 'via'     else null end,
           'reason',   case when jsonb_typeof(e -> 'reason')  = 'string' then e -> 'reason'  else null end,
           'quantity', case when jsonb_typeof(e -> 'quantity') = 'number' and (e ->> 'quantity') ~ '^[1-9][0-9]*$' then e -> 'quantity' else null end,
           'target',   case when jsonb_typeof(e -> 'target') = 'object'
                            then jsonb_strip_nulls(jsonb_build_object(
                                   'masterProductId',  case when jsonb_typeof(e #> '{target,masterProductId}') = 'string' then e #> '{target,masterProductId}' else null end,
                                   'masterVariantSku', case when jsonb_typeof(e #> '{target,masterVariantSku}') = 'string' then e #> '{target,masterVariantSku}' else null end))
                            else null end)))
    into v_lines
    from jsonb_array_elements(case when jsonb_typeof(p_resolution -> 'lines') = 'array' then p_resolution -> 'lines' else '[]'::jsonb end) e;

  select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'masterProductId',  case when jsonb_typeof(e -> 'masterProductId')  = 'string' then e -> 'masterProductId'  else null end,
           'masterVariantSku', case when jsonb_typeof(e -> 'masterVariantSku') = 'string' then e -> 'masterVariantSku' else null end,
           'quantity',         case when jsonb_typeof(e -> 'quantity') = 'number' and (e ->> 'quantity') ~ '^[1-9][0-9]*$' then e -> 'quantity' else null end,
           'lineKeys',         (select jsonb_agg(y) from jsonb_array_elements(
                                  case when jsonb_typeof(e -> 'lineKeys') = 'array' then e -> 'lineKeys' else '[]'::jsonb end) y
                                 where jsonb_typeof(y) = 'string'))))
    into v_targets
    from jsonb_array_elements(case when jsonb_typeof(p_resolution -> 'targets') = 'array' then p_resolution -> 'targets' else '[]'::jsonb end) e;

  select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'lineKey', case when jsonb_typeof(e -> 'lineKey') = 'string' then e -> 'lineKey' else null end,
           'reason',  case when jsonb_typeof(e -> 'reason')  = 'string' then e -> 'reason'  else null end)))
    into v_reasons
    from jsonb_array_elements(case when jsonb_typeof(p_resolution -> 'reasons') = 'array' then p_resolution -> 'reasons' else '[]'::jsonb end) e;

  v_safe := jsonb_strip_nulls(jsonb_build_object(
    'lines',    v_lines,
    'targets',  v_targets,
    'reasons',  v_reasons,
    'lineKeys', (select jsonb_agg(y) from jsonb_array_elements(
                   case when jsonb_typeof(p_resolution -> 'lineKeys') = 'array' then p_resolution -> 'lineKeys' else '[]'::jsonb end) y
                  where jsonb_typeof(y) = 'string'),
    'reason',   case when jsonb_typeof(p_resolution -> 'reason')  = 'string' then p_resolution -> 'reason'  else null end,
    'via',      case when jsonb_typeof(p_resolution -> 'via')     = 'string' then p_resolution -> 'via'     else null end,
    'method',   case when jsonb_typeof(p_resolution -> 'method')  = 'string' then p_resolution -> 'method'  else null end
  ));

  perform pg_advisory_xact_lock(hashtext(p_dedup_key));

  select processing_status, dedup_key into v_status, v_dedup
    from talabat_orders where id = p_order_id for update;
  if not found then
    return jsonb_build_object('status', 'error', 'reason', 'order_not_found');
  end if;

  if v_status in ('processed', 'manual_review') then
    if v_dedup is not null and v_dedup <> p_dedup_key then
      return jsonb_build_object('status', 'duplicate_order', 'idempotent', true);
    end if;
    return jsonb_build_object('status', v_status, 'idempotent', true);
  end if;

  if v_dedup is not null and v_dedup <> p_dedup_key then
    v_fail := 'duplicate_order';
  elsif exists (select 1 from talabat_orders where dedup_key = p_dedup_key and id <> p_order_id) then
    v_fail := 'duplicate_order';
  end if;

  if v_fail is null then
    update talabat_orders set dedup_key = p_dedup_key
     where id = p_order_id and (dedup_key is null or dedup_key = p_dedup_key);
    get diagnostics v_rows = row_count;
    if v_rows <> 1 then v_fail := 'duplicate_order'; end if;
  end if;

  -- STRICT plan-shape validation (staged; no cast shares its guard).
  if v_fail is null then
    if p_plan is null or jsonb_typeof(p_plan) <> 'object'
       or (p_plan ->> 'status') is distinct from 'ready'
       or jsonb_typeof(p_plan -> 'deductions') <> 'array'
       or jsonb_array_length(p_plan -> 'deductions') = 0 then
      v_fail := 'invalid_plan';
    else
      for v_ded in select * from jsonb_array_elements(p_plan -> 'deductions') loop
        v_msku := v_ded -> 'masterVariantSku';
        if (v_ded ->> 'masterProductId') is null or (v_ded ->> 'masterProductId') !~ v_uuid_re then
          v_fail := 'invalid_plan'; exit;
        end if;
        if not (jsonb_typeof(v_msku) = 'null'
                or (jsonb_typeof(v_msku) = 'string' and length(v_ded ->> 'masterVariantSku') > 0)) then
          v_fail := 'invalid_plan'; exit;
        end if;
        if jsonb_typeof(v_ded -> 'quantity') <> 'number' then
          v_fail := 'invalid_plan'; exit;
        end if;
        if (v_ded ->> 'quantity') !~ '^[1-9][0-9]*$' then
          v_fail := 'invalid_plan'; exit;
        end if;
        if (v_ded ->> 'quantity')::bigint > 2147483647 then
          v_fail := 'invalid_plan'; exit;
        end if;
      end loop;
    end if;
  end if;

  -- Resolve each deduction (masterProductId + masterVariantSku) to a durable
  -- canonical target (productId + variantId). A sku that does not resolve to
  -- exactly one variant of the product is an inventory inconsistency.
  if v_fail is null then
    for v_ded in select * from jsonb_array_elements(p_plan -> 'deductions') loop
      v_pid  := (v_ded ->> 'masterProductId')::uuid;
      v_vsku := case when jsonb_typeof(v_ded -> 'masterVariantSku') = 'string' then v_ded ->> 'masterVariantSku' else null end;
      if v_vsku is null then
        v_canon := v_canon || jsonb_build_array(jsonb_build_object(
          'productId', v_pid, 'variantId', null, 'quantity', (v_ded ->> 'quantity')::int));
      else
        select count(*), min(id) into v_cnt, v_vid
          from product_variants where parent_product_id = v_pid and sku = v_vsku;
        if v_cnt <> 1 then v_fail := 'inventory_inconsistent'; exit; end if;
        v_canon := v_canon || jsonb_build_array(jsonb_build_object(
          'productId', v_pid, 'variantId', v_vid, 'quantity', (v_ded ->> 'quantity')::int));
      end if;
    end loop;
  end if;

  -- Any pre-sale failure → manual_review, nothing deducted (classified reason).
  if v_fail is not null then
    update talabat_orders
       set processing_status = 'manual_review', processed_at = now(),
           resolution = v_safe || jsonb_build_object('reason', v_fail)
     where id = p_order_id;
    return jsonb_build_object('status', 'manual_review', 'reason', v_fail);
  end if;

  -- Delegate the numeric sale + audit to the canonical primitive.
  v_res := public.inv_apply_sale_targets(v_canon, 'talabat', p_order_id::text);

  if (v_res ->> 'status') is distinct from 'applied' then
    v_fail := coalesce(v_res ->> 'reason', 'inventory_inconsistent');
    if v_fail not in ('insufficient_stock', 'inventory_inconsistent', 'invalid_plan', 'parent_has_shelf_rows') then
      v_fail := 'inventory_inconsistent';
    end if;
    update talabat_orders
       set processing_status = 'manual_review', processed_at = now(),
           resolution = v_safe || jsonb_build_object('reason', v_fail)
     where id = p_order_id;
    return jsonb_build_object('status', 'manual_review', 'reason', v_fail);
  end if;

  update talabat_orders
     set processing_status = 'processed', processed_at = now(),
         dedup_key = coalesce(dedup_key, p_dedup_key),
         resolution = v_safe
   where id = p_order_id;
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    -- Could not finalize the order status after a successful sale → roll back the
    -- whole call (sale + audit + status) by raising; caller treats as rpc failure.
    raise exception 'talabat_finalize_rowcount';
  end if;

  return jsonb_build_object(
    'status', 'processed',
    'deductedUnits', coalesce((v_res ->> 'deductedUnits')::int, 0),
    'products', coalesce(v_res -> 'products', '[]'::jsonb),
    'variants', coalesce(v_res -> 'variants', '[]'::jsonb)
  );
end;
$$;

revoke all on function public.process_talabat_order_deduction(uuid, text, jsonb, jsonb) from public;
revoke all on function public.process_talabat_order_deduction(uuid, text, jsonb, jsonb) from anon;
revoke all on function public.process_talabat_order_deduction(uuid, text, jsonb, jsonb) from authenticated;
grant execute on function public.process_talabat_order_deduction(uuid, text, jsonb, jsonb) to service_role;
