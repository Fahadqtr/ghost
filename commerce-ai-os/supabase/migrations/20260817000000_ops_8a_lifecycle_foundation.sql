-- ============================================================================
-- OPS.8A — Lifecycle Safety Foundation (Phase 1 of the amended OPS.8 design).
--
-- ADDITIVE + rollback-friendly. Three things, all safety/foundation only:
--
--   1) products.lifecycle_state  — the canonical PRODUCT-level lifecycle field.
--      Domain is exactly {DRAFT, ACTIVE, STOPPED}. READY is DERIVED (never
--      stored); ARCHIVED is DERIVED from product_archive (an archived product has
--      no live row to hold a value); PUBLISHED/HIDDEN are per-STOREFRONT channel
--      concepts and never appear here. platform_status is NOT renamed or removed.
--
--   2) archive_product_bundle → v3. The v2 bundle preserved product + inventory +
--      variants + both shelf tables + channel_products, but NOT product_images or
--      external_channel_listings (both cascade-delete on product delete), so a v2
--      restore silently lost images + channel identity. v3 additionally snapshots
--      product_images and external_channel_listings so archive/restore is
--      full-fidelity. v2/v1 bundles remain restorable (absent arrays ⇒ empty).
--
--   3) restore_product_archive → v3-aware. Restores images (de-duplicated by id,
--      primary/gallery semantics preserved verbatim) and ECL, but RE-CHECKS ECL
--      uniqueness first: if an external identity or exported SKU is now owned by a
--      DIFFERENT live product, the conflicting mapping is NOT overwritten — it is
--      skipped and reported as eclConflicts (needs_review). Storefront isolation
--      is intrinsic (the external unique key is storefront-scoped). Every restored
--      product returns as lifecycle_state='DRAFT' — never ACTIVE, never published.
--
-- No inventory/availability business logic changes: the certified reconciliation
-- (matches lib/inventory/reconcile-compute.ts) is preserved byte-for-byte. Both
-- RPCs stay SECURITY DEFINER + service_role-only. Fixed reason codes only.
-- 2147483647 = max int4.
-- ============================================================================

-- ── 1) products.lifecycle_state (additive; backfilled; then constrained) ──────
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS lifecycle_state text;

-- Backfill LIVE products only (archived rows are not in products). Active → ACTIVE;
-- everything else (Draft / null / blank / any non-Active) → DRAFT. No STOPPED
-- source exists. Only fill NULLs so a re-run never overwrites a real value.
DO $$
DECLARE v_active integer; v_draft integer; v_total integer;
BEGIN
  UPDATE public.products
     SET lifecycle_state = CASE WHEN platform_status = 'Active' THEN 'ACTIVE' ELSE 'DRAFT' END
   WHERE lifecycle_state IS NULL;

  SELECT count(*) FILTER (WHERE lifecycle_state = 'ACTIVE'),
         count(*) FILTER (WHERE lifecycle_state = 'DRAFT'),
         count(*)
    INTO v_active, v_draft, v_total
    FROM public.products;
  RAISE NOTICE 'OPS.8A backfill: total=% active=% draft=% stopped=0', v_total, v_active, v_draft;
END $$;

ALTER TABLE public.products ALTER COLUMN lifecycle_state SET DEFAULT 'DRAFT';
ALTER TABLE public.products ALTER COLUMN lifecycle_state SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_lifecycle_state_check') THEN
    ALTER TABLE public.products
      ADD CONSTRAINT products_lifecycle_state_check
      CHECK (lifecycle_state = ANY (ARRAY['DRAFT','ACTIVE','STOPPED']));
  END IF;
END $$;

-- ============================================================================
-- 2) archive_product_bundle — v3 (adds product_images + external_channel_listings)
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
  v_images        jsonb;
  v_ecl           jsonb;
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

  PERFORM 1 FROM public.products WHERE id = p_product_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'error', 'reason', 'product_not_found');
  END IF;

  PERFORM 1 FROM public.product_variants
   WHERE parent_product_id = p_product_id ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.inventory
   WHERE product_id = p_product_id ORDER BY id FOR UPDATE;

  SELECT count(*) INTO v_inv_count FROM public.inventory WHERE product_id = p_product_id;
  IF v_inv_count > 1 THEN
    RETURN jsonb_build_object('status', 'error', 'reason', 'inventory_ambiguous');
  END IF;

  SELECT to_jsonb(p.*) INTO v_product FROM public.products p WHERE p.id = p_product_id;

  SELECT coalesce(jsonb_agg(to_jsonb(i.*) ORDER BY i.id), '[]'::jsonb)
    INTO v_inventory FROM public.inventory i WHERE i.product_id = p_product_id;

  SELECT coalesce(jsonb_agg(to_jsonb(pv.*) ORDER BY pv.id), '[]'::jsonb)
    INTO v_variants FROM public.product_variants pv WHERE pv.parent_product_id = p_product_id;

  SELECT count(*) INTO v_variant_count
    FROM public.product_variants WHERE parent_product_id = p_product_id;
  v_has_variants := v_variant_count > 0;

  PERFORM 1 FROM public.shelf_stock ss
     JOIN public.inventory i ON i.id = ss.inventory_id
    WHERE i.product_id = p_product_id ORDER BY ss.id FOR UPDATE OF ss;
  SELECT coalesce(jsonb_agg(to_jsonb(ss.*) ORDER BY ss.id), '[]'::jsonb)
    INTO v_shelf
    FROM public.shelf_stock ss
    JOIN public.inventory i ON i.id = ss.inventory_id
   WHERE i.product_id = p_product_id;

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

  -- v3 additions — snapshot (and lock) product_images + ECL BEFORE the delete so
  -- they are preserved in the bundle instead of being lost to ON DELETE CASCADE.
  PERFORM 1 FROM public.product_images WHERE product_id = p_product_id ORDER BY id FOR UPDATE;
  SELECT coalesce(jsonb_agg(to_jsonb(pi.*) ORDER BY pi.id), '[]'::jsonb)
    INTO v_images FROM public.product_images pi WHERE pi.product_id = p_product_id;

  PERFORM 1 FROM public.external_channel_listings WHERE product_id = p_product_id ORDER BY id FOR UPDATE;
  SELECT coalesce(jsonb_agg(to_jsonb(e.*) ORDER BY e.id), '[]'::jsonb)
    INTO v_ecl FROM public.external_channel_listings e WHERE e.product_id = p_product_id;

  v_bundle := jsonb_build_object(
    'version', 3,
    'product', v_product,
    'inventory', v_inventory,
    'variants', v_variants,
    'shelf_stock', v_shelf,
    'variant_shelf_stock', v_var_shelf,
    'channel_products', v_channels,
    'product_images', v_images,
    'external_channel_listings', v_ecl
  );

  INSERT INTO public.product_archive
    (product_id, sku, barcode, name_en, name_ar, image_url, bundle, archived_by)
  VALUES (
    p_product_id,
    v_product->>'sku', v_product->>'barcode',
    v_product->>'name_en', v_product->>'name_ar', v_product->>'image_url',
    v_bundle, p_archived_by
  )
  RETURNING id INTO v_archive_id;

  -- Delete dependents (deterministic order), including the v3-preserved tables,
  -- then the product. Everything is now safely inside the bundle.
  DELETE FROM public.variant_shelf_stock vss
   USING public.product_variants pv
   WHERE vss.variant_id = pv.id AND pv.parent_product_id = p_product_id;

  DELETE FROM public.shelf_stock ss
   USING public.inventory i
   WHERE ss.inventory_id = i.id AND i.product_id = p_product_id;

  DELETE FROM public.external_channel_listings WHERE product_id = p_product_id;
  DELETE FROM public.product_images WHERE product_id = p_product_id;
  DELETE FROM public.channel_products WHERE product_id = p_product_id;
  DELETE FROM public.product_variants WHERE parent_product_id = p_product_id;
  DELETE FROM public.inventory WHERE product_id = p_product_id;

  DELETE FROM public.products WHERE id = p_product_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
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
    'imageCount', jsonb_array_length(v_images),
    'eclCount', jsonb_array_length(v_ecl),
    'archiveVersion', 3
  );

EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object('status', 'error', 'reason', 'archive_failed');
END;
$$;

-- ============================================================================
-- 3) restore_product_archive — v3-aware (images + conflict-safe ECL + DRAFT)
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
  v_images        jsonb;
  v_ecl           jsonb;
  v_inv_row       jsonb;
  v_has_variants  boolean;
  v_variant_count integer;
  v_final_stock   numeric := 0;
  v_max_fs        numeric := 0;
  v_location      text := NULL;
  v_variants_recon jsonb := '[]'::jsonb;
  v_bad           integer;
  v_img_restored  integer := 0;
  v_ecl_total     integer := 0;
  v_ecl_restored  integer := 0;
BEGIN
  IF p_archive_id IS NULL THEN
    RETURN jsonb_build_object('status', 'error', 'reason', 'archive_not_found');
  END IF;

  SELECT bundle INTO v_bundle FROM public.product_archive WHERE id = p_archive_id FOR UPDATE;
  IF NOT FOUND OR v_bundle IS NULL OR jsonb_typeof(v_bundle) <> 'object' THEN
    RETURN jsonb_build_object('status', 'error', 'reason', 'archive_not_found');
  END IF;

  -- ── PASS 1: shape ─────────────────────────────────────────────────────────
  v_version := coalesce(nullif(v_bundle->>'version', '')::integer, 1);
  v_product := v_bundle->'product';
  IF v_product IS NULL OR jsonb_typeof(v_product) <> 'object' THEN
    RETURN jsonb_build_object('status', 'error', 'reason', 'bundle_invalid');
  END IF;
  v_product_id := v_product->>'id';
  IF v_product_id IS NULL OR btrim(v_product_id) = '' THEN
    RETURN jsonb_build_object('status', 'error', 'reason', 'bundle_invalid');
  END IF;

  -- v1/v2 bundles carry no images/ECL arrays ⇒ empty (never invent) but still
  -- restorable. Newer arrays default empty too when absent.
  v_inventory := coalesce(v_bundle->'inventory', '[]'::jsonb);
  v_variants  := coalesce(v_bundle->'variants', '[]'::jsonb);
  v_shelf     := coalesce(v_bundle->'shelf_stock', '[]'::jsonb);
  v_var_shelf := coalesce(v_bundle->'variant_shelf_stock', '[]'::jsonb);
  v_channels  := coalesce(v_bundle->'channel_products', '[]'::jsonb);
  v_images    := coalesce(v_bundle->'product_images', '[]'::jsonb);
  v_ecl       := coalesce(v_bundle->'external_channel_listings', '[]'::jsonb);

  IF jsonb_typeof(v_inventory) <> 'array' OR jsonb_typeof(v_variants) <> 'array'
     OR jsonb_typeof(v_shelf) <> 'array' OR jsonb_typeof(v_var_shelf) <> 'array'
     OR jsonb_typeof(v_channels) <> 'array' OR jsonb_typeof(v_images) <> 'array'
     OR jsonb_typeof(v_ecl) <> 'array' THEN
    RETURN jsonb_build_object('status', 'error', 'reason', 'bundle_invalid');
  END IF;

  IF jsonb_array_length(v_inventory) <> 1 THEN
    RETURN jsonb_build_object('status', 'error', 'reason', 'inventory_row_invalid');
  END IF;
  v_inv_row := v_inventory->0;
  IF (v_inv_row->>'product_id') IS DISTINCT FROM v_product_id THEN
    RETURN jsonb_build_object('status', 'error', 'reason', 'reference_mismatch');
  END IF;

  v_variant_count := jsonb_array_length(v_variants);
  v_has_variants := v_variant_count > 0;

  SELECT v_variant_count - count(DISTINCT (e->>'id'))
    INTO v_bad FROM jsonb_array_elements(v_variants) AS e;
  IF v_bad <> 0 THEN
    RETURN jsonb_build_object('status', 'error', 'reason', 'duplicate_identity');
  END IF;

  SELECT count(*) INTO v_bad FROM jsonb_array_elements(v_variants) AS e
   WHERE nullif(btrim(coalesce(e->>'id', '')), '') IS NULL
      OR (e->>'parent_product_id') IS DISTINCT FROM v_product_id;
  IF v_bad > 0 THEN
    RETURN jsonb_build_object('status', 'error', 'reason', 'reference_mismatch');
  END IF;

  SELECT count(*) INTO v_bad FROM jsonb_array_elements(v_var_shelf) AS e
   WHERE NOT EXISTS (
     SELECT 1 FROM jsonb_array_elements(v_variants) AS v WHERE (v->>'id') = (e->>'variant_id')
   );
  IF v_bad > 0 THEN
    RETURN jsonb_build_object('status', 'error', 'reason', 'reference_mismatch');
  END IF;

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

  -- ── PASS 2: reconciliation (unchanged authoritative model) ────────────────
  IF v_has_variants THEN
    IF jsonb_array_length(v_shelf) > 0 THEN
      RETURN jsonb_build_object('status', 'error', 'reason', 'parent_has_shelf_rows');
    END IF;

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
    IF jsonb_array_length(v_var_shelf) > 0 THEN
      RETURN jsonb_build_object('status', 'error', 'reason', 'reference_mismatch');
    END IF;

    IF jsonb_array_length(v_shelf) > 0 THEN
      SELECT count(*) INTO v_bad FROM jsonb_array_elements(v_shelf) AS e
       WHERE (e->>'inventory_id') IS DISTINCT FROM (v_inv_row->>'id');
      IF v_bad > 0 THEN
        RETURN jsonb_build_object('status', 'error', 'reason', 'reference_mismatch');
      END IF;

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
  -- Product WITHOUT the retired stock_quantity mirror, and ALWAYS lifecycle_state
  -- = 'DRAFT' (never restore to ACTIVE, never auto-publish). Old bundles have no
  -- lifecycle_state key; stripping is a no-op and the DRAFT value is forced in.
  INSERT INTO public.products
  SELECT * FROM jsonb_populate_record(
    NULL::public.products,
    (v_product - 'stock_quantity' - 'lifecycle_state')
      || jsonb_build_object('lifecycle_state', 'DRAFT')
  );

  INSERT INTO public.inventory
  SELECT * FROM jsonb_populate_record(
    NULL::public.inventory,
    (v_inv_row - 'stock_quantity' - 'location')
      || jsonb_build_object('stock_quantity', v_final_stock::int, 'location', v_location)
  );

  IF jsonb_array_length(v_variants_recon) > 0 THEN
    INSERT INTO public.product_variants
    SELECT * FROM jsonb_populate_recordset(NULL::public.product_variants, v_variants_recon);
  END IF;

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

  -- v3 images: restore verbatim (primary/gallery semantics kept), de-duplicated
  -- by id so a re-run or a stray survivor never double-inserts.
  IF jsonb_array_length(v_images) > 0 THEN
    INSERT INTO public.product_images
    SELECT r.* FROM jsonb_populate_recordset(NULL::public.product_images, v_images) AS r
     WHERE NOT EXISTS (SELECT 1 FROM public.product_images x WHERE x.id = r.id);
    GET DIAGNOSTICS v_img_restored = ROW_COUNT;
  END IF;

  -- v3 ECL: re-check uniqueness. Insert ONLY rows whose external identity and
  -- exported SKU are NOT already held by a live row (which would be a different
  -- active product). Conflicting rows are skipped (never overwrite) and reported
  -- as eclConflicts → needs_review. Storefront isolation is intrinsic (the unique
  -- keys are storefront-scoped).
  v_ecl_total := jsonb_array_length(v_ecl);
  IF v_ecl_total > 0 THEN
    INSERT INTO public.external_channel_listings
    SELECT r.* FROM jsonb_populate_recordset(NULL::public.external_channel_listings, v_ecl) AS r
     WHERE NOT EXISTS (
             SELECT 1 FROM public.external_channel_listings x
              WHERE x.storefront_key = r.storefront_key
                AND r.external_product_id IS NOT NULL
                AND x.external_product_id = r.external_product_id
                AND coalesce(x.external_variant_id, '') = coalesce(r.external_variant_id, ''))
       AND NOT EXISTS (
             SELECT 1 FROM public.external_channel_listings x
              WHERE x.storefront_key = r.storefront_key
                AND r.exported_sku IS NOT NULL
                AND lower(x.exported_sku) = lower(r.exported_sku));
    GET DIAGNOSTICS v_ecl_restored = ROW_COUNT;
  END IF;

  DELETE FROM public.product_archive WHERE id = p_archive_id;

  RETURN jsonb_build_object(
    'status', 'applied',
    'productId', v_product_id,
    'lifecycleState', 'DRAFT',
    'hasVariants', v_has_variants,
    'stock', v_final_stock::int,
    'variantCount', v_variant_count,
    'productShelfCount', jsonb_array_length(v_shelf),
    'variantShelfCount', jsonb_array_length(v_var_shelf),
    'channelCount', jsonb_array_length(v_channels),
    'imageCount', v_img_restored,
    'eclRestored', v_ecl_restored,
    'eclConflicts', v_ecl_total - v_ecl_restored,
    'archiveVersion', v_version
  );

EXCEPTION
  WHEN unique_violation THEN
    RETURN jsonb_build_object('status', 'error', 'reason', 'restore_conflict');
  WHEN foreign_key_violation THEN
    RETURN jsonb_build_object('status', 'error', 'reason', 'restore_conflict');
  WHEN OTHERS THEN
    RETURN jsonb_build_object('status', 'error', 'reason', 'restore_failed');
END;
$$;

-- ── Security: service-role only (unchanged; re-applied idempotently) ─────────
REVOKE ALL ON FUNCTION public.archive_product_bundle(uuid, text) FROM public;
REVOKE ALL ON FUNCTION public.archive_product_bundle(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.archive_product_bundle(uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.archive_product_bundle(uuid, text) TO service_role;

REVOKE ALL ON FUNCTION public.restore_product_archive(uuid) FROM public;
REVOKE ALL ON FUNCTION public.restore_product_archive(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.restore_product_archive(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.restore_product_archive(uuid) TO service_role;

-- ============================================================================
-- ROLLBACK (manual; additive migration):
--   ALTER TABLE public.products DROP CONSTRAINT IF EXISTS products_lifecycle_state_check;
--   ALTER TABLE public.products DROP COLUMN IF EXISTS lifecycle_state;
--   -- and re-apply the INV.4E v2 function bodies (this file's CREATE OR REPLACE is
--   -- backward-compatible, so a rollback is only needed to revert bundle version).
-- No destructive drops are performed by this migration.
-- ============================================================================
