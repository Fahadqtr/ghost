-- ============================================================================
-- INV.4D — harden sync_product_variants: fail-closed quantities + atomic parent
-- rollup, so the product editor can never leave inventory.stock_quantity stale or
-- take the parent pool from a top-level form field.
--
-- CREATE OR REPLACE of the EXISTING function (supabase/product_variants_durable_identity.sql).
-- SAME signature, SAME SECURITY INVOKER model, SAME search_path, SAME grants, and
-- ALL existing identity/duplicate/delete guards preserved verbatim. What INV.4D adds:
--
--   * Deterministic locking: the product's variant rows (ORDER BY id) then its
--     inventory row are locked FOR UPDATE before any read/write.
--   * Fail-closed quantities: a RETAINED variant must submit a valid non-negative
--     integer stock (no silent null→0, no fractional, no negative, no int4 overflow);
--     a NEW variant may omit it (defaults to 0). Rejected as 'variant_invalid_quantity'.
--   * Shelf-tracked variant protection: a retained variant that has variant_shelf_stock
--     rows may be edited (metadata) but its submitted stock MUST equal its current
--     (shelf-derived) stock — otherwise 'variant_stock_managed_by_shelves'. The editor
--     never rewrites shelf-managed variant quantities.
--   * Parent/variant shelf conflict: if the product will still have variants AND the
--     parent carries product-level shelf_stock rows, that is an inconsistent state —
--     rejected 'variant_parent_shelf_conflict'. No auto-reconciliation, no dirty-row repair.
--   * Atomic parent rollup: after the variant set is final, if the product HAS variants
--     the parent inventory.stock_quantity is set = Σ variants inside THIS transaction
--     (rowcount-checked); if it has NONE, inventory is left untouched (the editor sets a
--     simple product's stock through the Inventory Engine, inv_set_absolute_product).
--   * Richer return: adds status/productId/hasVariants/parentBefore/parentStock and a
--     variantChanges array (before/after per variant) for the caller's audit + transition.
--     The legacy ok/updated/inserted/deleted fields are kept for backward compatibility.
--
-- NEVER touches products.stock_quantity (the mirror is a caller concern), stock_status
-- / availability, or sold_quantity. Uses Σ, never max(). 2147483647 = max int4.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.sync_product_variants(
  p_product_id uuid,
  p_variants   jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_submitted_ids uuid[];
  v_distinct_ids  uuid[];
  v_existing_ids  uuid[];
  v_retained_ids  uuid[];
  v_to_delete     uuid[];
  v_bad_count     integer;
  v_blocked       integer;
  v_new_count     integer := 0;
  v_updated       integer := 0;
  v_inserted      integer := 0;
  v_deleted       integer := 0;
  v_will_have     boolean;
  v_final_count   integer := 0;
  v_inv_cnt       integer;
  v_parentbefore  bigint := 0;
  v_parentstock   bigint := 0;
  v_before_map    jsonb := '{}'::jsonb;
  v_changes_kept  jsonb := '[]'::jsonb;
  v_changes_del   jsonb := '[]'::jsonb;
  v_changes       jsonb := '[]'::jsonb;
  v_rows          integer;
BEGIN
  IF p_product_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'variant_sync_failed');
  END IF;
  IF p_variants IS NULL OR jsonb_typeof(p_variants) <> 'array' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'variant_sync_failed');
  END IF;

  -- Deterministic locks: this product's variants, then its inventory row.
  PERFORM 1 FROM public.product_variants
   WHERE parent_product_id = p_product_id ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.inventory WHERE product_id = p_product_id FOR UPDATE;

  -- Rows the caller claims already exist (non-null, non-blank id).
  SELECT coalesce(array_agg((e->>'id')::uuid), '{}')
    INTO v_submitted_ids
    FROM jsonb_array_elements(p_variants) AS e
   WHERE nullif(btrim(coalesce(e->>'id', '')), '') IS NOT NULL;

  -- Duplicate id in one submission.
  SELECT coalesce(array_agg(DISTINCT x), '{}') INTO v_distinct_ids
    FROM unnest(v_submitted_ids) AS x;
  IF array_length(v_submitted_ids, 1) IS DISTINCT FROM array_length(v_distinct_ids, 1) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'duplicate_variant_id');
  END IF;

  -- The authoritative set: ids that really belong to THIS product.
  SELECT coalesce(array_agg(pv.id), '{}')
    INTO v_existing_ids
    FROM public.product_variants pv
   WHERE pv.parent_product_id = p_product_id;

  -- Any submitted id outside that set is unknown or belongs to another product.
  SELECT count(*) INTO v_bad_count
    FROM unnest(v_submitted_ids) AS s(id)
   WHERE NOT (s.id = ANY (v_existing_ids));
  IF v_bad_count > 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unknown_variant_id');
  END IF;

  -- Ids that survive this save: submitted, with an id, and not blanked out.
  SELECT coalesce(array_agg((e->>'id')::uuid), '{}')
    INTO v_retained_ids
    FROM jsonb_array_elements(p_variants) AS e
   WHERE nullif(btrim(coalesce(e->>'id', '')), '') IS NOT NULL
     AND (
          nullif(btrim(coalesce(e->>'variant_name', '')), '')    IS NOT NULL
       OR nullif(btrim(coalesce(e->>'variant_name_en', '')), '') IS NOT NULL
       OR nullif(btrim(coalesce(e->>'sku', '')), '')             IS NOT NULL
     );

  SELECT coalesce(array_agg(x), '{}') INTO v_to_delete
    FROM unnest(v_existing_ids) AS x
   WHERE NOT (x = ANY (v_retained_ids));

  -- New (insertable) rows: no id, and at least one identifying field.
  SELECT count(*) INTO v_new_count
    FROM jsonb_array_elements(p_variants) AS e
   WHERE nullif(btrim(coalesce(e->>'id', '')), '') IS NULL
     AND (
          nullif(btrim(coalesce(e->>'variant_name', '')), '')    IS NOT NULL
       OR nullif(btrim(coalesce(e->>'variant_name_en', '')), '') IS NOT NULL
       OR nullif(btrim(coalesce(e->>'sku', '')), '')             IS NOT NULL
     );

  -- ── Fail-closed quantity validation ───────────────────────────────────────
  -- RETAINED rows MUST carry a valid non-negative integer stock (no null→0).
  SELECT count(*) INTO v_bad_count
    FROM jsonb_array_elements(p_variants) AS e
   WHERE nullif(btrim(coalesce(e->>'id', '')), '') IS NOT NULL
     AND (e->>'id')::uuid = ANY (v_retained_ids)
     AND (
          jsonb_typeof(e->'stock_quantity') <> 'number'
       OR (e->>'stock_quantity')::numeric < 0
       OR (e->>'stock_quantity')::numeric <> trunc((e->>'stock_quantity')::numeric)
       OR (e->>'stock_quantity')::numeric > 2147483647
     );
  IF v_bad_count > 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'variant_invalid_quantity');
  END IF;
  -- NEW rows MAY omit stock (defaults to 0); if provided it must still be valid.
  SELECT count(*) INTO v_bad_count
    FROM jsonb_array_elements(p_variants) AS e
   WHERE nullif(btrim(coalesce(e->>'id', '')), '') IS NULL
     AND jsonb_typeof(e->'stock_quantity') = 'number'
     AND (
          (e->>'stock_quantity')::numeric < 0
       OR (e->>'stock_quantity')::numeric <> trunc((e->>'stock_quantity')::numeric)
       OR (e->>'stock_quantity')::numeric > 2147483647
     );
  IF v_bad_count > 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'variant_invalid_quantity');
  END IF;

  -- ── Removal guards (checked BEFORE any write) ─────────────────────────────
  SELECT count(*) INTO v_blocked
    FROM public.variant_shelf_stock vss
   WHERE vss.variant_id = ANY (v_to_delete)
     AND coalesce(vss.quantity, 0) <> 0;
  IF v_blocked > 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'variant_has_shelf_stock');
  END IF;

  SELECT count(*) INTO v_blocked
    FROM public.product_variants pv
    JOIN public.channel_variant_mappings cvm
      ON cvm.master_product_id  = p_product_id
     AND cvm.master_variant_sku = pv.sku
   WHERE pv.id = ANY (v_to_delete)
     AND cvm.mapping_status IN ('active', 'needs_review');
  IF v_blocked > 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'variant_has_channel_mapping');
  END IF;

  -- ── Shelf-managed variant protection ──────────────────────────────────────
  -- A retained variant that has shelf placements is shelf-managed: its stock is
  -- Σ variant_shelf_stock and the editor must not change it. A metadata-only edit
  -- (submitted stock == current stock) is allowed; a stock change is rejected.
  SELECT count(*) INTO v_blocked
    FROM jsonb_array_elements(p_variants) AS e
    JOIN public.product_variants pv
      ON pv.id = (e->>'id')::uuid AND pv.parent_product_id = p_product_id
   WHERE nullif(btrim(coalesce(e->>'id', '')), '') IS NOT NULL
     AND (e->>'id')::uuid = ANY (v_retained_ids)
     AND EXISTS (SELECT 1 FROM public.variant_shelf_stock vss WHERE vss.variant_id = pv.id)
     AND (e->>'stock_quantity')::integer IS DISTINCT FROM pv.stock_quantity;
  IF v_blocked > 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'variant_stock_managed_by_shelves');
  END IF;

  -- ── Parent / variant shelf conflict ───────────────────────────────────────
  -- If the product will still have variants AND the parent carries product-level
  -- shelf rows, that is an inconsistent state. Fail closed; never reconcile here.
  v_will_have := (coalesce(array_length(v_retained_ids, 1), 0) > 0) OR (v_new_count > 0);
  IF v_will_have AND EXISTS (
        SELECT 1 FROM public.shelf_stock ss
          JOIN public.inventory i ON i.id = ss.inventory_id
         WHERE i.product_id = p_product_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'variant_parent_shelf_conflict');
  END IF;

  -- Snapshot BEFORE state for the return contract + parentBefore.
  SELECT coalesce(jsonb_object_agg(pv.id::text, coalesce(pv.stock_quantity, 0)), '{}'::jsonb),
         coalesce(sum(coalesce(pv.stock_quantity, 0)), 0)
    INTO v_before_map, v_parentbefore
    FROM public.product_variants pv
   WHERE pv.parent_product_id = p_product_id;

  -- ── Writes: update → insert → delete ──────────────────────────────────────
  WITH src AS (
    SELECT (e->>'id')::uuid                        AS id,
           nullif(btrim(coalesce(e->>'variant_name', '')), '')    AS variant_name,
           nullif(btrim(coalesce(e->>'variant_name_en', '')), '') AS variant_name_en,
           nullif(btrim(coalesce(e->>'sku', '')), '')             AS sku,
           nullif(btrim(coalesce(e->>'barcode', '')), '')         AS barcode,
           nullif(btrim(coalesce(e->>'color', '')), '')           AS color,
           nullif(btrim(coalesce(e->>'size', '')), '')            AS size,
           CASE WHEN jsonb_typeof(e->'price') = 'number'
                THEN (e->>'price')::numeric END       AS price,
           (e->>'stock_quantity')::integer            AS stock_quantity
      FROM jsonb_array_elements(p_variants) AS e
     WHERE nullif(btrim(coalesce(e->>'id', '')), '') IS NOT NULL
       AND (e->>'id')::uuid = ANY (v_retained_ids)
  )
  UPDATE public.product_variants pv
     SET variant_name    = src.variant_name,
         variant_name_en = src.variant_name_en,
         sku             = src.sku,
         barcode         = src.barcode,
         color           = src.color,
         size            = src.size,
         price           = src.price,
         stock_quantity  = src.stock_quantity
    FROM src
   WHERE pv.id = src.id
     AND pv.parent_product_id = p_product_id;
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  WITH src AS (
    SELECT nullif(btrim(coalesce(e->>'variant_name', '')), '')    AS variant_name,
           nullif(btrim(coalesce(e->>'variant_name_en', '')), '') AS variant_name_en,
           nullif(btrim(coalesce(e->>'sku', '')), '')             AS sku,
           nullif(btrim(coalesce(e->>'barcode', '')), '')         AS barcode,
           nullif(btrim(coalesce(e->>'color', '')), '')           AS color,
           nullif(btrim(coalesce(e->>'size', '')), '')            AS size,
           CASE WHEN jsonb_typeof(e->'price') = 'number'
                THEN (e->>'price')::numeric END       AS price,
           coalesce(CASE WHEN jsonb_typeof(e->'stock_quantity') = 'number'
                THEN (e->>'stock_quantity')::integer END, 0) AS stock_quantity
      FROM jsonb_array_elements(p_variants) AS e
     WHERE nullif(btrim(coalesce(e->>'id', '')), '') IS NULL
       AND (
            nullif(btrim(coalesce(e->>'variant_name', '')), '')    IS NOT NULL
         OR nullif(btrim(coalesce(e->>'variant_name_en', '')), '') IS NOT NULL
         OR nullif(btrim(coalesce(e->>'sku', '')), '')             IS NOT NULL
       )
  )
  INSERT INTO public.product_variants
    (parent_product_id, variant_name, variant_name_en, sku, barcode, color, size, price, stock_quantity)
  SELECT p_product_id, src.variant_name, src.variant_name_en, src.sku, src.barcode,
         src.color, src.size, src.price, src.stock_quantity
    FROM src;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  IF array_length(v_to_delete, 1) > 0 THEN
    DELETE FROM public.variant_shelf_stock vss
     WHERE vss.variant_id = ANY (v_to_delete);

    DELETE FROM public.product_variants pv
     WHERE pv.id = ANY (v_to_delete)
       AND pv.parent_product_id = p_product_id;
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
  END IF;

  -- ── Final state + atomic parent rollup ────────────────────────────────────
  SELECT count(*), coalesce(sum(coalesce(stock_quantity, 0)), 0)
    INTO v_final_count, v_parentstock
    FROM public.product_variants
   WHERE parent_product_id = p_product_id;
  v_will_have := v_final_count > 0;

  IF v_parentstock > 2147483647 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'variant_invalid_quantity');
  END IF;

  IF v_will_have THEN
    SELECT count(*) INTO v_inv_cnt FROM public.inventory WHERE product_id = p_product_id;
    IF v_inv_cnt <> 1 THEN
      -- The editor fail-closes on a missing inventory row before calling this; a
      -- variant product with no/duplicate inventory row is an anomaly here.
      RETURN jsonb_build_object('ok', false, 'error', 'variant_sync_failed');
    END IF;
    UPDATE public.inventory
       SET stock_quantity = v_parentstock::int, updated_at = now()
     WHERE product_id = p_product_id;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'variant_sync_failed');
    END IF;
  END IF;

  -- variantChanges: retained/inserted from current rows, deleted from the snapshot.
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'variantId',   pv.id,
           'variantName', pv.variant_name,
           'kind',        CASE WHEN v_before_map ? pv.id::text THEN 'updated' ELSE 'inserted' END,
           'before',      CASE WHEN v_before_map ? pv.id::text THEN (v_before_map->>pv.id::text)::int ELSE 0 END,
           'after',       coalesce(pv.stock_quantity, 0)
         )), '[]'::jsonb)
    INTO v_changes_kept
    FROM public.product_variants pv
   WHERE pv.parent_product_id = p_product_id;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'variantId',   d,
           'variantName', NULL,
           'kind',        'deleted',
           'before',      (v_before_map->>d::text)::int,
           'after',       0
         )), '[]'::jsonb)
    INTO v_changes_del
    FROM unnest(v_to_delete) AS d;

  v_changes := v_changes_kept || v_changes_del;

  RETURN jsonb_build_object(
    'ok', true, 'status', 'applied', 'productId', p_product_id,
    'hasVariants', v_will_have,
    'updated', v_updated, 'inserted', v_inserted, 'deleted', v_deleted,
    'parentBefore', v_parentbefore,
    'parentStock', CASE WHEN v_will_have THEN v_parentstock ELSE NULL END,
    'variantChanges', v_changes
  );

EXCEPTION
  WHEN OTHERS THEN
    -- Never surface SQLERRM, a constraint name, or any table/column detail.
    RETURN jsonb_build_object('ok', false, 'error', 'variant_sync_failed');
END;
$$;

-- Grants unchanged: signed-in users only; RLS on the underlying tables governs
-- what the call can actually read/write (SECURITY INVOKER).
REVOKE ALL ON FUNCTION public.sync_product_variants(uuid, jsonb) FROM public;
REVOKE ALL ON FUNCTION public.sync_product_variants(uuid, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.sync_product_variants(uuid, jsonb) TO authenticated;
