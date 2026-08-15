-- ============================================================================
-- INV.6B — Migration A: RUNTIME BRIDGE (additive / backward-compatible).
--
-- May be deployed to production BEFORE the INV.6B code merge. It introduces the
-- atomic product-state INITIALIZATION RPCs (so the last two create-seed direct
-- writers can disappear from the runtime), hardens sync_product_variants to
-- SECURITY DEFINER (keeping authenticated EXECUTE temporarily for the transition),
-- and makes restore_product_archive compatible with the future auto-seed trigger
-- (Migration B). It adds NO constraints, NO RLS/ACL changes, NO triggers — those
-- are the strict lockdown in Migration B.
--
-- 2147483647 = max int4. Availability (stock_status) and the retired
-- products.stock_quantity mirror are NEVER touched here.
-- ============================================================================

-- ============================================================================
-- 1) inv_initialize_product_state — atomic state init for a JUST-CREATED product.
--
-- Initializes the authoritative inventory (+ variants) for a brand-new product.
-- It is NOT a generic stock-set: it only ever acts on a pristine new product
-- (zero inventory rows, OR exactly one pristine zero auto-seed), and requires
-- zero pre-existing variants. Forward-compatible with the Migration B auto-seed
-- trigger: claims/updates the pristine seed when present, else creates the row.
--
-- SIMPLE  (p_variants empty): inventory.stock_quantity = p_simple_stock.
-- VARIANT (p_variants array): each variant stock is a valid non-negative int4
--   (NO NULL); parent inventory.stock_quantity = Σ variants (bigint); p_simple_stock
--   is IGNORED as authority; location NULL; no product/variant shelf rows.
-- Writes NO audit/sale/task/availability/mirror.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.inv_initialize_product_state(
  p_product_id   uuid,
  p_simple_stock integer,
  p_variants     jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_inv_count   integer;
  v_inv_id      uuid;
  v_is_variant  boolean;
  v_variant_cnt integer;
  v_parent      bigint;
  v_norm        jsonb;
  v_bad         integer;
  v_e           jsonb;
BEGIN
  IF p_product_id IS NULL THEN RETURN jsonb_build_object('status','error','reason','invalid_target'); END IF;
  IF p_variants IS NULL OR jsonb_typeof(p_variants) <> 'array' THEN
    RETURN jsonb_build_object('status','error','reason','invalid_variants');
  END IF;

  -- Product must exist; lock it (+ its dependents) deterministically.
  PERFORM 1 FROM products WHERE id = p_product_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','error','reason','product_not_found'); END IF;
  PERFORM 1 FROM product_variants WHERE parent_product_id = p_product_id ORDER BY id FOR UPDATE;
  PERFORM 1 FROM inventory WHERE product_id = p_product_id ORDER BY id FOR UPDATE;

  -- Initialization only: the product must have NO pre-existing variants.
  IF EXISTS (SELECT 1 FROM product_variants WHERE parent_product_id = p_product_id) THEN
    RETURN jsonb_build_object('status','error','reason','product_already_initialized');
  END IF;

  v_is_variant := jsonb_array_length(p_variants) > 0;

  -- ── Validate authority ────────────────────────────────────────────────────
  IF v_is_variant THEN
    -- Every variant stock must be a valid non-negative int4 (no NULL).
    SELECT count(*) INTO v_bad FROM jsonb_array_elements(p_variants) AS e
     WHERE jsonb_typeof(e -> 'stock_quantity') <> 'number'
        OR (e ->> 'stock_quantity')::numeric < 0
        OR (e ->> 'stock_quantity')::numeric <> trunc((e ->> 'stock_quantity')::numeric)
        OR (e ->> 'stock_quantity')::numeric > 2147483647;
    IF v_bad > 0 THEN RETURN jsonb_build_object('status','error','reason','invalid_variant_stock'); END IF;

    SELECT coalesce(sum((e ->> 'stock_quantity')::bigint), 0)
      INTO v_parent FROM jsonb_array_elements(p_variants) AS e;
    IF v_parent > 2147483647 THEN RETURN jsonb_build_object('status','error','reason','invalid_variant_stock'); END IF;
    v_variant_cnt := jsonb_array_length(p_variants);
  ELSE
    IF p_simple_stock IS NULL OR p_simple_stock < 0 OR p_simple_stock > 2147483647 THEN
      RETURN jsonb_build_object('status','error','reason','invalid_seed');
    END IF;
    v_parent := p_simple_stock::bigint;
    v_variant_cnt := 0;
  END IF;

  -- ── Claim or create the pristine inventory seed ───────────────────────────
  SELECT count(*) INTO v_inv_count FROM inventory WHERE product_id = p_product_id;
  IF v_inv_count = 0 THEN
    INSERT INTO inventory (product_id, stock_quantity, sold_quantity, low_stock_threshold, location)
    VALUES (p_product_id, v_parent::int, 0, 5, NULL)
    RETURNING id INTO v_inv_id;
  ELSIF v_inv_count = 1 THEN
    -- Only a PRISTINE auto-seed may be claimed (stock 0 / sold 0 / no location / no shelves).
    SELECT id INTO v_inv_id FROM inventory WHERE product_id = p_product_id;
    IF EXISTS (SELECT 1 FROM inventory WHERE id = v_inv_id
                AND (stock_quantity <> 0 OR coalesce(sold_quantity,0) <> 0 OR location IS NOT NULL))
       OR EXISTS (SELECT 1 FROM shelf_stock WHERE inventory_id = v_inv_id) THEN
      RETURN jsonb_build_object('status','error','reason','not_a_pristine_seed');
    END IF;
    UPDATE inventory SET stock_quantity = v_parent::int, sold_quantity = 0, location = NULL, updated_at = now()
     WHERE id = v_inv_id;
  ELSE
    RETURN jsonb_build_object('status','error','reason','inventory_ambiguous');
  END IF;

  -- ── Insert variants atomically (variant product) ─────────────────────────
  IF v_is_variant THEN
    SELECT coalesce(jsonb_agg(
             (e - 'id' - 'created_at' - 'parent_product_id' - 'stock_quantity')
               || jsonb_build_object('parent_product_id', p_product_id,
                                     'stock_quantity', (e ->> 'stock_quantity')::int)
           ), '[]'::jsonb)
      INTO v_norm FROM jsonb_array_elements(p_variants) AS e;
    INSERT INTO product_variants
    SELECT * FROM jsonb_populate_recordset(NULL::product_variants, v_norm);
  END IF;

  RETURN jsonb_build_object(
    'status','applied','productId',p_product_id,'inventoryId',v_inv_id,
    'parentStock',v_parent::int,'variantCount',v_variant_cnt);
END;
$$;

REVOKE ALL ON FUNCTION public.inv_initialize_product_state(uuid, integer, jsonb) FROM public;
REVOKE ALL ON FUNCTION public.inv_initialize_product_state(uuid, integer, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.inv_initialize_product_state(uuid, integer, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.inv_initialize_product_state(uuid, integer, jsonb) TO service_role;

-- ============================================================================
-- 2) inv_initialize_simple_products — batch simple-product initializer.
--    All-or-nothing per CALL: validate every row first; then init each (create or
--    claim the pristine seed). Targets must be NEW simple products (no variants).
-- ============================================================================
CREATE OR REPLACE FUNCTION public.inv_initialize_simple_products(
  p_rows jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uuid_re text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_bad     integer;
  v_row     jsonb;
  v_pid     uuid;
  v_stock   integer;
  v_inv_cnt integer;
  v_inv_id  uuid;
  v_ids     jsonb := '[]'::jsonb;
  v_count   integer := 0;
BEGIN
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RETURN jsonb_build_object('status','error','reason','invalid_rows');
  END IF;
  IF jsonb_array_length(p_rows) = 0 THEN
    RETURN jsonb_build_object('status','applied','initialized',0,'ids','[]'::jsonb);
  END IF;

  -- Validate ALL rows first (all-or-nothing).
  SELECT count(*) INTO v_bad FROM jsonb_array_elements(p_rows) AS e
   WHERE (e ->> 'productId') IS NULL OR (e ->> 'productId') !~ v_uuid_re
      OR jsonb_typeof(e -> 'stockQuantity') <> 'number'
      OR (e ->> 'stockQuantity')::numeric < 0
      OR (e ->> 'stockQuantity')::numeric <> trunc((e ->> 'stockQuantity')::numeric)
      OR (e ->> 'stockQuantity')::numeric > 2147483647;
  IF v_bad > 0 THEN RETURN jsonb_build_object('status','error','reason','invalid_rows'); END IF;

  FOR v_row IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    v_pid := (v_row ->> 'productId')::uuid;
    v_stock := (v_row ->> 'stockQuantity')::int;

    PERFORM 1 FROM products WHERE id = v_pid FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('status','error','reason','product_not_found'); END IF;
    IF EXISTS (SELECT 1 FROM product_variants WHERE parent_product_id = v_pid) THEN
      RETURN jsonb_build_object('status','error','reason','product_has_variants');
    END IF;

    SELECT count(*) INTO v_inv_cnt FROM inventory WHERE product_id = v_pid;
    IF v_inv_cnt = 0 THEN
      INSERT INTO inventory (product_id, stock_quantity, sold_quantity, low_stock_threshold, location)
      VALUES (v_pid, v_stock, 0, 5, NULL) RETURNING id INTO v_inv_id;
    ELSIF v_inv_cnt = 1 THEN
      SELECT id INTO v_inv_id FROM inventory WHERE product_id = v_pid;
      IF EXISTS (SELECT 1 FROM inventory WHERE id = v_inv_id
                  AND (stock_quantity <> 0 OR coalesce(sold_quantity,0) <> 0 OR location IS NOT NULL))
         OR EXISTS (SELECT 1 FROM shelf_stock WHERE inventory_id = v_inv_id) THEN
        RETURN jsonb_build_object('status','error','reason','not_a_pristine_seed');
      END IF;
      UPDATE inventory SET stock_quantity = v_stock, sold_quantity = 0, location = NULL, updated_at = now()
       WHERE id = v_inv_id;
    ELSE
      RETURN jsonb_build_object('status','error','reason','inventory_ambiguous');
    END IF;

    v_ids := v_ids || to_jsonb(v_pid);
    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object('status','applied','initialized',v_count,'ids',v_ids);
END;
$$;

REVOKE ALL ON FUNCTION public.inv_initialize_simple_products(jsonb) FROM public;
REVOKE ALL ON FUNCTION public.inv_initialize_simple_products(jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.inv_initialize_simple_products(jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.inv_initialize_simple_products(jsonb) TO service_role;

-- ============================================================================
-- 3) sync_product_variants — harden to SECURITY DEFINER (no body rewrite).
--    ALTER FUNCTION preserves the entire INV.4D body + validation exactly; only
--    the security mode changes. search_path is already public, pg_temp. Keep
--    authenticated EXECUTE TEMPORARILY (the editor switches to the service-role
--    client in this PR's code); service_role too. Migration B revokes authenticated.
-- ============================================================================
ALTER FUNCTION public.sync_product_variants(uuid, jsonb) SECURITY DEFINER;
ALTER FUNCTION public.sync_product_variants(uuid, jsonb) SET search_path = public, pg_temp;
GRANT EXECUTE ON FUNCTION public.sync_product_variants(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_product_variants(uuid, jsonb) TO service_role;

-- ============================================================================
-- 4) restore_product_archive — make it compatible with the future auto-seed
--    trigger (Migration B). After the products INSERT, an AFTER INSERT trigger
--    will create ONE pristine zero inventory row with a NEW id. Restore must then
--    delete that pristine seed and re-insert the ARCHIVED inventory row under its
--    ORIGINAL id (archived shelf inventory ids are preserved). Before the trigger
--    exists, no seed row is present and this is a no-op — identical INV.4E behavior.
--    Everything else is byte-for-byte the INV.4E body.
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
  v_seed_count    integer;
BEGIN
  IF p_archive_id IS NULL THEN
    RETURN jsonb_build_object('status', 'error', 'reason', 'archive_not_found');
  END IF;

  SELECT bundle INTO v_bundle FROM public.product_archive WHERE id = p_archive_id FOR UPDATE;
  IF NOT FOUND OR v_bundle IS NULL OR jsonb_typeof(v_bundle) <> 'object' THEN
    RETURN jsonb_build_object('status', 'error', 'reason', 'archive_not_found');
  END IF;

  v_version := coalesce(nullif(v_bundle->>'version', '')::integer, 1);
  v_product := v_bundle->'product';
  IF v_product IS NULL OR jsonb_typeof(v_product) <> 'object' THEN
    RETURN jsonb_build_object('status', 'error', 'reason', 'bundle_invalid');
  END IF;
  v_product_id := v_product->>'id';
  IF v_product_id IS NULL OR btrim(v_product_id) = '' THEN
    RETURN jsonb_build_object('status', 'error', 'reason', 'bundle_invalid');
  END IF;

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

  -- ── PASS 3: apply ─────────────────────────────────────────────────────────
  INSERT INTO public.products
  SELECT * FROM jsonb_populate_record(NULL::public.products, v_product - 'stock_quantity');

  -- INV.6B bridge: if the (Migration B) auto-seed trigger just created a pristine
  -- zero inventory row for this product, remove it so the archived inventory row
  -- can be restored under its ORIGINAL id (UNIQUE(product_id) allows only one).
  -- Only a PRISTINE seed may be removed; anything else fails the whole restore.
  SELECT count(*) INTO v_seed_count FROM public.inventory WHERE product_id = v_product_id::uuid;
  IF v_seed_count > 0 THEN
    IF v_seed_count <> 1
       OR EXISTS (SELECT 1 FROM public.inventory
                   WHERE product_id = v_product_id::uuid
                     AND (stock_quantity <> 0 OR coalesce(sold_quantity,0) <> 0 OR location IS NOT NULL))
       OR EXISTS (SELECT 1 FROM public.shelf_stock ss JOIN public.inventory i ON i.id = ss.inventory_id
                   WHERE i.product_id = v_product_id::uuid) THEN
      RAISE EXCEPTION 'restore_seed_not_pristine';
    END IF;
    DELETE FROM public.inventory WHERE product_id = v_product_id::uuid;
  END IF;

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
    RETURN jsonb_build_object('status', 'error', 'reason', 'restore_conflict');
  WHEN foreign_key_violation THEN
    RETURN jsonb_build_object('status', 'error', 'reason', 'restore_conflict');
  WHEN OTHERS THEN
    RETURN jsonb_build_object('status', 'error', 'reason', 'restore_failed');
END;
$$;

REVOKE ALL ON FUNCTION public.restore_product_archive(uuid) FROM public;
REVOKE ALL ON FUNCTION public.restore_product_archive(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.restore_product_archive(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.restore_product_archive(uuid) TO service_role;
