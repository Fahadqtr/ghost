-- ============================================================================
-- Durable product-variant identity  (Phase UI.3D.0)
-- Run ONCE in the Supabase SQL editor. Safe to re-run (fully idempotent).
-- ----------------------------------------------------------------------------
-- WHY
-- Until now, saving a product deleted every `product_variants` row for it and
-- re-inserted the submitted set, so `product_variants.id` changed on every
-- edit. Anything holding a variant id was silently orphaned — in this schema
-- that is `variant_shelf_stock.variant_id`, which is a plain uuid with NO
-- foreign key, so nothing errored and nothing cascaded.
--
-- A production check before writing this migration found the orphan backlog to
-- be empty (0 rows, 0 variant ids, 0 quantity), so there is deliberately NO
-- data-repair statement here. This migration only stops the bleeding.
--
-- WHAT THIS DOES
--   A. A unique index on (parent_product_id, id) so a future composite foreign
--      key can prove "this variant belongs to this product".
--   B. An atomic variant-sync function used by updateProduct.
--
-- TRANSACTION SCOPE — read this before relying on it:
--   * The product row update and the variant sync are NOT one transaction
--     together. They are two separate statements from the application.
--   * The variant sync ITSELF is all-or-nothing: validation, updates, inserts
--     and deletes all happen inside this one function call, so a failure rolls
--     the whole variant set back.
--   * Consequently a failed sync can no longer delete the previous variant set.
--     Under the old code the DELETE was committed before the INSERT ran, so a
--     duplicate-SKU error wiped every option off the product.
--
-- SCOPE LIMIT: this function touches the variant set only. It deliberately does
-- NOT write `products`, `inventory`, orders, or channel tables — product-field
-- cleaning/normalisation stays in TypeScript rather than being duplicated here.
-- ============================================================================

-- ── A. Composite-key support ────────────────────────────────────────────────
-- Cannot fail: `id` is already the primary key, so any superset of it is unique.
CREATE UNIQUE INDEX IF NOT EXISTS product_variants_parent_id_id_uk
  ON public.product_variants (parent_product_id, id);


-- ── B. Atomic variant sync ──────────────────────────────────────────────────
-- Input is a single JSONB array. Each element:
--   { "id": "<uuid>" | null,        -- null/absent = new variant
--     "variant_name": text, "variant_name_en": text,
--     "sku": text, "barcode": text, "color": text, "size": text,
--     "price": numeric | null, "stock_quantity": integer | null }
--
-- Returns JSONB: {"ok":true,"updated":n,"inserted":n,"deleted":n}
--             or {"ok":false,"error":"<fixed code>"}
--
-- Error codes are FIXED IDENTIFIERS, never raw database text, and never contain
-- a uuid, a constraint name, a table name or SQL. The caller maps them to fixed
-- user-facing messages:
--   unknown_variant_id        a submitted id does not belong to this product
--   duplicate_variant_id      the same id was submitted twice
--   variant_has_shelf_stock   a removed variant still holds shelf quantity
--   variant_has_channel_mapping  a removed variant is still mapped to a channel
--   variant_sync_failed       anything else
--
-- SECURITY INVOKER: the function runs with the CALLER's privileges, so existing
-- RLS on product_variants / variant_shelf_stock / channel_variant_mappings
-- still applies. It never elevates, never reads a service role, and never
-- accepts a user id or an authorization flag from the client — the caller's
-- session is the only identity.
--
-- search_path is pinned so an attacker-controlled schema cannot shadow a table
-- or function name. No dynamic SQL is used anywhere.

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
  v_updated       integer := 0;
  v_inserted      integer := 0;
  v_deleted       integer := 0;
BEGIN
  IF p_product_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'variant_sync_failed');
  END IF;
  IF p_variants IS NULL OR jsonb_typeof(p_variants) <> 'array' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'variant_sync_failed');
  END IF;

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
  -- The whole call aborts; nothing is written.
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

  -- ── Removal guards (checked BEFORE any write) ─────────────────────────────

  -- A variant still holding real shelf quantity is never removed, and its
  -- quantity is never silently zeroed.
  SELECT count(*) INTO v_blocked
    FROM public.variant_shelf_stock vss
   WHERE vss.variant_id = ANY (v_to_delete)
     AND coalesce(vss.quantity, 0) <> 0;
  IF v_blocked > 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'variant_has_shelf_stock');
  END IF;

  -- A variant still mapped to a sales channel is never removed. The mapping is
  -- matched on the variant's CURRENT sku, which is how channel_variant_mappings
  -- keys its rows. The mapping itself is left untouched — resolving it is an
  -- explicit operator action, not a side effect of editing a product.
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

  -- ── Writes: update → insert → delete ──────────────────────────────────────
  -- Deleting last means a failure earlier cannot leave the product with fewer
  -- variants than it started with.

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
           CASE WHEN jsonb_typeof(e->'stock_quantity') = 'number'
                THEN (e->>'stock_quantity')::integer END AS stock_quantity
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
     AND pv.parent_product_id = p_product_id;  -- ownership re-checked at write time
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  -- New rows: the uuid is generated by the database. A client-supplied id is
  -- never used for an insert.
  WITH src AS (
    SELECT nullif(btrim(coalesce(e->>'variant_name', '')), '')    AS variant_name,
           nullif(btrim(coalesce(e->>'variant_name_en', '')), '') AS variant_name_en,
           nullif(btrim(coalesce(e->>'sku', '')), '')             AS sku,
           nullif(btrim(coalesce(e->>'barcode', '')), '')         AS barcode,
           nullif(btrim(coalesce(e->>'color', '')), '')           AS color,
           nullif(btrim(coalesce(e->>'size', '')), '')            AS size,
           CASE WHEN jsonb_typeof(e->'price') = 'number'
                THEN (e->>'price')::numeric END       AS price,
           CASE WHEN jsonb_typeof(e->'stock_quantity') = 'number'
                THEN (e->>'stock_quantity')::integer END AS stock_quantity
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

  -- Removals: shelf rows that exist but are all zero are cleaned up here, in
  -- the same transaction, so no orphan can be created.
  IF array_length(v_to_delete, 1) > 0 THEN
    DELETE FROM public.variant_shelf_stock vss
     WHERE vss.variant_id = ANY (v_to_delete);

    DELETE FROM public.product_variants pv
     WHERE pv.id = ANY (v_to_delete)
       AND pv.parent_product_id = p_product_id;
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'updated', v_updated, 'inserted', v_inserted, 'deleted', v_deleted
  );

EXCEPTION
  WHEN OTHERS THEN
    -- Never surface SQLERRM, a constraint name, or any table/column detail.
    RETURN jsonb_build_object('ok', false, 'error', 'variant_sync_failed');
END;
$$;

-- Callable by signed-in users only; RLS on the underlying tables still governs
-- what the call can actually read and write (SECURITY INVOKER).
REVOKE ALL ON FUNCTION public.sync_product_variants(uuid, jsonb) FROM public;
REVOKE ALL ON FUNCTION public.sync_product_variants(uuid, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.sync_product_variants(uuid, jsonb) TO authenticated;

-- ── Verification (run manually after applying) ──────────────────────────────
-- READ-ONLY. Never call sync_product_variants to "test" it: an empty array is
-- a valid instruction to remove every removable variant of that product, so a
-- casual verification call would delete real data.
--
-- 1. the composite-key index exists
--   select indexname from pg_indexes
--    where schemaname = 'public' and tablename = 'product_variants'
--      and indexname = 'product_variants_parent_id_id_uk';
--
-- 2. the function exists with the expected signature, is SECURITY INVOKER,
--    and has a pinned search_path
--   select p.proname,
--          pg_get_function_identity_arguments(p.oid) as args,
--          p.prosecdef            as is_security_definer,  -- expect false
--          p.proconfig            as settings               -- expect {search_path=public, pg_temp}
--     from pg_proc p
--     join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and p.proname = 'sync_product_variants';
--
-- 3. EXECUTE is granted to authenticated and NOT to anon
--   select grantee, privilege_type
--     from information_schema.role_routine_grants
--    where specific_schema = 'public' and routine_name = 'sync_product_variants';
--   -- expect a row for 'authenticated'; expect NO row for 'anon' or 'PUBLIC'
