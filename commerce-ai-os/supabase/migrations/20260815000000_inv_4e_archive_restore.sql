-- ============================================================================
-- INV.4E — atomic archive / restore + products.stock_quantity mirror retirement.
--
-- Two things happen here, both schema-level:
--
-- 1) products.stock_quantity DEFAULT is dropped (was DEFAULT 0). INV.4E retires
--    the mirror: nothing in the runtime writes it any more, so a fresh product
--    insert must NOT resurrect a 0 mirror on every row. The column is NOT dropped
--    and existing values are NOT touched (no mass cleanup) — it becomes a frozen
--    legacy compatibility column that simply stops changing. Its retirement to a
--    dropped column is a later phase.
--
-- 2) Two service-role-only RPCs replace the multi-step, non-atomic JS archive /
--    restore in app/(app)/products/archive/actions.ts:
--
--      archive_product_bundle(p_product_id uuid, p_archived_by text) → jsonb
--      restore_product_archive(p_archive_id uuid)                    → jsonb
--
--    ARCHIVE snapshots the FULL bundle — product + inventory + variants + BOTH
--    shelf tables (shelf_stock, variant_shelf_stock) + channel_products — into
--    product_archive.bundle as a version-2 object, then deletes the live product
--    and every dependent row in one transaction. Either the whole archive+delete
--    succeeds or nothing changes; no orphan shelf rows, no half-deleted product.
--
--    RESTORE reads the bundle (version-1 legacy bundles supported: no shelf
--    arrays ⇒ treated as empty), RECONCILES the quantities against the
--    authoritative inventory model BEFORE inserting (never restores drift or the
--    stale products.stock_quantity mirror), and re-inserts everything + deletes
--    the archive row in one transaction. Any conflict/failure rolls the whole
--    restore back and leaves the archive row intact — no partial restore.
--
-- Reconciliation model (matches lib/inventory/reconcile-compute.ts):
--   • simple  → inventory.stock_quantity is authoritative; if product-level
--               shelf rows exist, stock = Σ shelf and location = the deterministic
--               primary shelf (largest quantity, then location ASC); with no shelf
--               rows the archived inventory quantity is preserved and location is
--               reset to NULL (never restore a stale shelf pointer).
--   • variant → each variant's stock = Σ its variant_shelf rows when it has any,
--               else the archived variant quantity; the parent inventory pool =
--               Σ variant stocks and its location is NULL. Product-level shelf
--               rows on a variant product are inconsistent → fail closed.
--
-- SECURITY DEFINER + service_role-only EXECUTE: full bundle restoration crosses
-- RLS on several tables, so the RPCs run as the definer; the browser can never
-- call them (the server action gates on requireUser() then calls with the admin
-- client). Fixed reason codes only — never SQLERRM / a table / a column / a uuid.
-- 2147483647 = max int4.
-- ============================================================================

-- 1) Retire the mirror's DEFAULT (was 0). No column drop, no value rewrite.
ALTER TABLE public.products ALTER COLUMN stock_quantity DROP DEFAULT;

-- ============================================================================
-- archive_product_bundle — atomic snapshot + delete.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.archive_product_bundle(
  p_product_id uuid,
  p_archived_by text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_product       jsonb;
  v_inventory     jsonb;
  v_variants      jsonb;
  v_shelf         jsonb;
  v_var_shelf     jsonb;
  v_channels      jsonb;
  v_bundle        jsonb;
  v_archive_id    uuid;
  v_inv_count     integer;
  v_variant_count integer;
  v_has_variants  boolean;
  v_rows          integer;
BEGIN
  IF p_product_id IS NULL THEN
    RETURN jsonb_build_object('status', 'error', 'reason', 'product_not_found');
  END IF;

  -- Lock the product; fail closed if it is already gone.
  PERFORM 1 FROM public.products WHERE id = p_product_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'error', 'reason', 'product_not_found');
  END IF;

  -- Deterministic locks on dependents: variants, then inventory rows.
  PERFORM 1 FROM public.product_variants
   WHERE parent_product_id = p_product_id ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.inventory
   WHERE product_id = p_product_id ORDER BY id FOR UPDATE;

  -- The authoritative pool must be unambiguous (no unique(product_id) exists).
  SELECT count(*) INTO v_inv_count FROM public.inventory WHERE product_id = p_product_id;
  IF v_inv_count > 1 THEN
    RETURN jsonb_build_object('status', 'error', 'reason', 'inventory_ambiguous');
  END IF;

  -- Full snapshots (deterministic ordering for stable bundles).
  SELECT to_jsonb(p.*) INTO v_product FROM public.products p WHERE p.id = p_product_id;

  SELECT coalesce(jsonb_agg(to_jsonb(i.*) ORDER BY i.id), '[]'::jsonb)
    INTO v_inventory FROM public.inventory i WHERE i.product_id = p_product_id;

  SELECT coalesce(jsonb_agg(to_jsonb(pv.*) ORDER BY pv.id), '[]'::jsonb)
    INTO v_variants FROM public.product_variants pv WHERE pv.parent_product_id = p_product_id;

  SELECT count(*) INTO v_variant_count
    FROM public.product_variants WHERE parent_product_id = p_product_id;
  v_has_variants := v_variant_count > 0;

  -- Product-level shelf placements (via inventory_id) — lock them too.
  PERFORM 1 FROM public.shelf_stock ss
     JOIN public.inventory i ON i.id = ss.inventory_id
    WHERE i.product_id = p_product_id ORDER BY ss.id FOR UPDATE OF ss;
  SELECT coalesce(jsonb_agg(to_jsonb(ss.*) ORDER BY ss.id), '[]'::jsonb)
    INTO v_shelf
    FROM public.shelf_stock ss
    JOIN public.inventory i ON i.id = ss.inventory_id
   WHERE i.product_id = p_product_id;

  -- Variant-level shelf placements (via variant_id) — lock them too.
  PERFORM 1 FROM public.variant_shelf_stock vss
     JOIN public.product_variants pv ON pv.id = vss.variant_id
    WHERE pv.parent_product_id = p_product_id ORDER BY vss.id FOR UPDATE OF vss;
  SELECT coalesce(jsonb_agg(to_jsonb(vss.*) ORDER BY vss.id), '[]'::jsonb)
    INTO v_var_shelf
    FROM public.variant_shelf_stock vss
    JOIN public.product_variants pv ON pv.id = vss.variant_id
   WHERE pv.parent_product_id = p_product_id;

  SELECT coalesce(jsonb_agg(to_jsonb(cp.*) ORDER BY cp.id), '[]'::jsonb)
    INTO v_channels FROM public.channel_products cp WHERE cp.product_id = p_product_id;

  v_bundle := jsonb_build_object(
    'version', 2,
    'product', v_product,
    'inventory', v_inventory,
    'variants', v_variants,
    'shelf_stock', v_shelf,
    'variant_shelf_stock', v_var_shelf,
    'channel_products', v_channels
  );

  -- Snapshot row (denormalized identity columns kept for the archive list UI).
  INSERT INTO public.product_archive
    (product_id, sku, barcode, name_en, name_ar, image_url, bundle, archived_by)
  VALUES (
    p_product_id,
    v_product->>'sku', v_product->>'barcode',
    v_product->>'name_en', v_product->>'name_ar', v_product->>'image_url',
    v_bundle, p_archived_by
  )
  RETURNING id INTO v_archive_id;

  -- Delete dependents in dependency-safe order, then the product itself.
  DELETE FROM public.variant_shelf_stock vss
   USING public.product_variants pv
   WHERE vss.variant_id = pv.id AND pv.parent_product_id = p_product_id;

  DELETE FROM public.shelf_stock ss
   USING public.inventory i
   WHERE ss.inventory_id = i.id AND i.product_id = p_product_id;

  DELETE FROM public.channel_products WHERE product_id = p_product_id;
  DELETE FROM public.product_variants WHERE parent_product_id = p_product_id;
  DELETE FROM public.inventory WHERE product_id = p_product_id;

  DELETE FROM public.products WHERE id = p_product_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    -- Raise → caught below → the whole transaction (archive insert + deletes)
    -- rolls back. Never a half-archived state.
    RAISE EXCEPTION 'archive_delete_rowcount';
  END IF;

  RETURN jsonb_build_object(
    'status', 'archived',
    'archiveId', v_archive_id,
    'productId', p_product_id,
    'hasVariants', v_has_variants,
    'inventoryCount', v_inv_count,
    'variantCount', v_variant_count,
    'productShelfCount', jsonb_array_length(v_shelf),
    'variantShelfCount', jsonb_array_length(v_var_shelf),
    'channelCount', jsonb_array_length(v_channels),
    'archiveVersion', 2
  );

EXCEPTION
  WHEN OTHERS THEN
    -- Any failure rolls back the archive insert AND every delete.
    RETURN jsonb_build_object('status', 'error', 'reason', 'archive_failed');
END;
$$;

-- ============================================================================
-- restore_product_archive — validate + reconcile + atomic re-insert.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.restore_product_archive(
  p_archive_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_bundle        jsonb;
  v_version       integer;
  v_product       jsonb;
  v_product_id    text;
  v_inventory     jsonb;
  v_variants      jsonb;
  v_shelf         jsonb;
  v_var_shelf     jsonb;
  v_channels      jsonb;
  v_inv_row       jsonb;
  v_has_variants  boolean;
  v_variant_count integer;
  v_final_stock   numeric := 0;
  v_max_fs        numeric := 0;
  v_location      text := NULL;
  v_variants_recon jsonb := '[]'::jsonb;
  v_bad           integer;
BEGIN
  IF p_archive_id IS NULL THEN
    RETURN jsonb_build_object('status', 'error', 'reason', 'archive_not_found');
  END IF;

  -- Lock the archive row for the lifetime of the restore.
  SELECT bundle INTO v_bundle FROM public.product_archive WHERE id = p_archive_id FOR UPDATE;
  IF NOT FOUND OR v_bundle IS NULL OR jsonb_typeof(v_bundle) <> 'object' THEN
    RETURN jsonb_build_object('status', 'error', 'reason', 'archive_not_found');
  END IF;

  -- ── PASS 1: bundle shape ──────────────────────────────────────────────────
  v_version := coalesce(nullif(v_bundle->>'version', '')::integer, 1);
  v_product := v_bundle->'product';
  IF v_product IS NULL OR jsonb_typeof(v_product) <> 'object' THEN
    RETURN jsonb_build_object('status', 'error', 'reason', 'bundle_invalid');
  END IF;
  v_product_id := v_product->>'id';
  IF v_product_id IS NULL OR btrim(v_product_id) = '' THEN
    RETURN jsonb_build_object('status', 'error', 'reason', 'bundle_invalid');
  END IF;

  -- Legacy v1 bundles carry no shelf arrays / version ⇒ treat as empty (never
  -- invent placements) but never reject solely for being old.
  v_inventory := coalesce(v_bundle->'inventory', '[]'::jsonb);
  v_variants  := coalesce(v_bundle->'variants', '[]'::jsonb);
  v_shelf     := coalesce(v_bundle->'shelf_stock', '[]'::jsonb);
  v_var_shelf := coalesce(v_bundle->'variant_shelf_stock', '[]'::jsonb);
  v_channels  := coalesce(v_bundle->'channel_products', '[]'::jsonb);

  IF jsonb_typeof(v_inventory) <> 'array' OR jsonb_typeof(v_variants) <> 'array'
     OR jsonb_typeof(v_shelf) <> 'array' OR jsonb_typeof(v_var_shelf) <> 'array'
     OR jsonb_typeof(v_channels) <> 'array' THEN
    RETURN jsonb_build_object('status', 'error', 'reason', 'bundle_invalid');
  END IF;

  -- Exactly one authoritative inventory row is required by the model.
  IF jsonb_array_length(v_inventory) <> 1 THEN
    RETURN jsonb_build_object('status', 'error', 'reason', 'inventory_row_invalid');
  END IF;
  v_inv_row := v_inventory->0;
  IF (v_inv_row->>'product_id') IS DISTINCT FROM v_product_id THEN
    RETURN jsonb_build_object('status', 'error', 'reason', 'reference_mismatch');
  END IF;

  v_variant_count := jsonb_array_length(v_variants);
  v_has_variants := v_variant_count > 0;

  -- Duplicate variant identity inside the bundle.
  SELECT v_variant_count - count(DISTINCT (e->>'id'))
    INTO v_bad FROM jsonb_array_elements(v_variants) AS e;
  IF v_bad <> 0 THEN
    RETURN jsonb_build_object('status', 'error', 'reason', 'duplicate_identity');
  END IF;

  -- Every variant: valid id + parent reference back to the product.
  SELECT count(*) INTO v_bad FROM jsonb_array_elements(v_variants) AS e
   WHERE nullif(btrim(coalesce(e->>'id', '')), '') IS NULL
      OR (e->>'parent_product_id') IS DISTINCT FROM v_product_id;
  IF v_bad > 0 THEN
    RETURN jsonb_build_object('status', 'error', 'reason', 'reference_mismatch');
  END IF;

  -- Variant-shelf rows must reference a variant that exists in the bundle.
  SELECT count(*) INTO v_bad FROM jsonb_array_elements(v_var_shelf) AS e
   WHERE NOT EXISTS (
     SELECT 1 FROM jsonb_array_elements(v_variants) AS v WHERE (v->>'id') = (e->>'variant_id')
   );
  IF v_bad > 0 THEN
    RETURN jsonb_build_object('status', 'error', 'reason', 'reference_mismatch');
  END IF;

  -- All shelf/variant-shelf quantities must be valid non-negative integers.
  SELECT count(*) INTO v_bad FROM (
    SELECT (e->'quantity') AS q, (e->>'quantity') AS qs FROM jsonb_array_elements(v_shelf) AS e
    UNION ALL
    SELECT (e->'quantity'), (e->>'quantity') FROM jsonb_array_elements(v_var_shelf) AS e
  ) s
   WHERE jsonb_typeof(q) <> 'number' OR qs::numeric < 0
      OR qs::numeric <> trunc(qs::numeric) OR qs::numeric > 2147483647;
  IF v_bad > 0 THEN
    RETURN jsonb_build_object('status', 'error', 'reason', 'malformed_quantity');
  END IF;

  -- ── PASS 2: reconciliation (authoritative model) ──────────────────────────
  IF v_has_variants THEN
    -- Product-level shelves on a variant product are inconsistent.
    IF jsonb_array_length(v_shelf) > 0 THEN
      RETURN jsonb_build_object('status', 'error', 'reason', 'parent_has_shelf_rows');
    END IF;

    -- A variant with NO shelf rows must carry a valid archived quantity.
    SELECT count(*) INTO v_bad FROM jsonb_array_elements(v_variants) AS v
     WHERE NOT EXISTS (
             SELECT 1 FROM jsonb_array_elements(v_var_shelf) AS e
              WHERE (e->>'variant_id') = (v->>'id'))
       AND ( jsonb_typeof(v->'stock_quantity') <> 'number'
          OR (v->>'stock_quantity')::numeric < 0
          OR (v->>'stock_quantity')::numeric <> trunc((v->>'stock_quantity')::numeric)
          OR (v->>'stock_quantity')::numeric > 2147483647 );
    IF v_bad > 0 THEN
      RETURN jsonb_build_object('status', 'error', 'reason', 'malformed_quantity');
    END IF;

    -- Each variant stock = Σ its variant-shelf rows (when any) else archived qty;
    -- parent pool = Σ variant stocks.
    WITH vs AS (
      SELECT (e->>'variant_id') AS vid, sum((e->>'quantity')::numeric) AS qty
        FROM jsonb_array_elements(v_var_shelf) AS e
       GROUP BY 1
    ),
    recon AS (
      SELECT v.value AS row,
             CASE WHEN vs.vid IS NOT NULL THEN vs.qty
                  ELSE (v.value->>'stock_quantity')::numeric END AS fs
        FROM jsonb_array_elements(v_variants) AS v(value)
        LEFT JOIN vs ON vs.vid = (v.value->>'id')
    )
    SELECT coalesce(jsonb_agg((row - 'stock_quantity')
             || jsonb_build_object('stock_quantity', fs)), '[]'::jsonb),
           coalesce(sum(fs), 0), coalesce(max(fs), 0)
      INTO v_variants_recon, v_final_stock, v_max_fs
      FROM recon;

    IF v_max_fs > 2147483647 OR v_final_stock > 2147483647 THEN
      RETURN jsonb_build_object('status', 'error', 'reason', 'malformed_quantity');
    END IF;
    v_location := NULL;

  ELSE
    -- Simple product: variant-shelf rows cannot exist (no variants own them).
    IF jsonb_array_length(v_var_shelf) > 0 THEN
      RETURN jsonb_build_object('status', 'error', 'reason', 'reference_mismatch');
    END IF;

    IF jsonb_array_length(v_shelf) > 0 THEN
      -- Every product-level shelf row must reference this inventory row.
      SELECT count(*) INTO v_bad FROM jsonb_array_elements(v_shelf) AS e
       WHERE (e->>'inventory_id') IS DISTINCT FROM (v_inv_row->>'id');
      IF v_bad > 0 THEN
        RETURN jsonb_build_object('status', 'error', 'reason', 'reference_mismatch');
      END IF;

      -- stock = Σ shelf; primary location = largest quantity, tie → location ASC.
      SELECT coalesce(sum((e->>'quantity')::numeric), 0)
        INTO v_final_stock FROM jsonb_array_elements(v_shelf) AS e;
      IF v_final_stock > 2147483647 THEN
        RETURN jsonb_build_object('status', 'error', 'reason', 'malformed_quantity');
      END IF;
      SELECT e->>'location' INTO v_location
        FROM jsonb_array_elements(v_shelf) AS e
       ORDER BY (e->>'quantity')::numeric DESC, e->>'location' ASC
       LIMIT 1;
    ELSE
      -- No shelves: preserve the archived inventory quantity (validated), and
      -- reset location to NULL (never restore a stale shelf pointer).
      IF jsonb_typeof(v_inv_row->'stock_quantity') <> 'number'
         OR (v_inv_row->>'stock_quantity')::numeric < 0
         OR (v_inv_row->>'stock_quantity')::numeric <> trunc((v_inv_row->>'stock_quantity')::numeric)
         OR (v_inv_row->>'stock_quantity')::numeric > 2147483647 THEN
        RETURN jsonb_build_object('status', 'error', 'reason', 'malformed_quantity');
      END IF;
      v_final_stock := (v_inv_row->>'stock_quantity')::numeric;
      v_location := NULL;
    END IF;
    v_variants_recon := '[]'::jsonb;
  END IF;

  -- ── PASS 3: apply (single transaction; any failure rolls back) ────────────
  -- Product WITHOUT the retired stock_quantity mirror. stock_status/availability
  -- restored verbatim (never derived from quantity).
  INSERT INTO public.products
  SELECT * FROM jsonb_populate_record(NULL::public.products, v_product - 'stock_quantity');

  -- Reconciled inventory row (authoritative stock + reconciled location).
  INSERT INTO public.inventory
  SELECT * FROM jsonb_populate_record(
    NULL::public.inventory,
    (v_inv_row - 'stock_quantity' - 'location')
      || jsonb_build_object('stock_quantity', v_final_stock::int, 'location', v_location)
  );

  -- Reconciled variants.
  IF jsonb_array_length(v_variants_recon) > 0 THEN
    INSERT INTO public.product_variants
    SELECT * FROM jsonb_populate_recordset(NULL::public.product_variants, v_variants_recon);
  END IF;

  -- Shelf placements verbatim (already validated + reconciled to authoritative).
  IF jsonb_array_length(v_shelf) > 0 THEN
    INSERT INTO public.shelf_stock
    SELECT * FROM jsonb_populate_recordset(NULL::public.shelf_stock, v_shelf);
  END IF;
  IF jsonb_array_length(v_var_shelf) > 0 THEN
    INSERT INTO public.variant_shelf_stock
    SELECT * FROM jsonb_populate_recordset(NULL::public.variant_shelf_stock, v_var_shelf);
  END IF;

  IF jsonb_array_length(v_channels) > 0 THEN
    INSERT INTO public.channel_products
    SELECT * FROM jsonb_populate_recordset(NULL::public.channel_products, v_channels);
  END IF;

  -- Only now — after a fully successful restore — drop the archive row.
  DELETE FROM public.product_archive WHERE id = p_archive_id;

  RETURN jsonb_build_object(
    'status', 'applied',
    'productId', v_product_id,
    'hasVariants', v_has_variants,
    'stock', v_final_stock::int,
    'variantCount', v_variant_count,
    'productShelfCount', jsonb_array_length(v_shelf),
    'variantShelfCount', jsonb_array_length(v_var_shelf),
    'channelCount', jsonb_array_length(v_channels),
    'archiveVersion', v_version
  );

EXCEPTION
  WHEN unique_violation THEN
    -- SKU/identity taken, or a bundle-internal duplicate id → nothing applied.
    RETURN jsonb_build_object('status', 'error', 'reason', 'restore_conflict');
  WHEN foreign_key_violation THEN
    -- A referenced brand/category/channel is gone → nothing applied.
    RETURN jsonb_build_object('status', 'error', 'reason', 'restore_conflict');
  WHEN OTHERS THEN
    RETURN jsonb_build_object('status', 'error', 'reason', 'restore_failed');
END;
$$;

-- ============================================================================
-- Security: service-role only. The browser never executes these directly; the
-- server action gates on requireUser() then calls with the service-role client.
-- ============================================================================
REVOKE ALL ON FUNCTION public.archive_product_bundle(uuid, text) FROM public;
REVOKE ALL ON FUNCTION public.archive_product_bundle(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.archive_product_bundle(uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.archive_product_bundle(uuid, text) TO service_role;

REVOKE ALL ON FUNCTION public.restore_product_archive(uuid) FROM public;
REVOKE ALL ON FUNCTION public.restore_product_archive(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.restore_product_archive(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.restore_product_archive(uuid) TO service_role;
