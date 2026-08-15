-- ============================================================================
-- INV.6B — Migration B: STRICT ENFORCEMENT (FINAL LOCKDOWN).
--
-- ⚠️ MUST NOT be applied to production until the INV.6B runtime is merged and the
-- new master deployment is Ready. It makes direct numeric/structural inventory
-- writes IMPOSSIBLE for every role except through the approved SECURITY DEFINER
-- RPCs, guarantees a product can never exist without exactly one inventory row,
-- and asserts the full authoritative model at every transaction boundary.
--
-- Production is verified clean (all integrity counts 0), so constraints validate
-- cleanly. NO data repair anywhere. 2147483647 = max int4. Availability
-- (stock_status) stays independent; the retired products.stock_quantity mirror is
-- never touched.
-- ============================================================================

-- ============================================================================
-- 1) AUTO INVENTORY SEED — a product can never be committed without inventory.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.inv_seed_inventory_on_product_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Exactly one pristine seed per new product. inventory UNIQUE(product_id) makes
  -- a duplicate impossible. The initializer RPC later claims/updates this seed.
  INSERT INTO public.inventory (product_id, stock_quantity, sold_quantity, low_stock_threshold, location)
  VALUES (NEW.id, 0, 0, 5, NULL);
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.inv_seed_inventory_on_product_insert() FROM public;
REVOKE ALL ON FUNCTION public.inv_seed_inventory_on_product_insert() FROM anon;
REVOKE ALL ON FUNCTION public.inv_seed_inventory_on_product_insert() FROM authenticated;
REVOKE ALL ON FUNCTION public.inv_seed_inventory_on_product_insert() FROM service_role;

DROP TRIGGER IF EXISTS trg_inv_seed_inventory ON public.products;
CREATE TRIGGER trg_inv_seed_inventory
  AFTER INSERT ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.inv_seed_inventory_on_product_insert();

-- ============================================================================
-- 2) ROW-LOCAL STRICT CONSTRAINTS (production clean → validate cleanly).
--    CHECKs added NOT VALID then VALIDATE'd; NOT NULL set directly. Named.
--    Shelf quantity CHECK is >= 0 (NOT > 0): INV.5 sales transiently set a shelf
--    row to 0 then DELETE it inside one transaction — the deferred cross-table
--    invariant (below) forbids a COMMITTED zero shelf row.
-- ============================================================================

-- inventory numeric authority
ALTER TABLE public.inventory ALTER COLUMN stock_quantity SET NOT NULL;
ALTER TABLE public.inventory ALTER COLUMN sold_quantity  SET NOT NULL;
ALTER TABLE public.inventory ADD CONSTRAINT inventory_stock_quantity_nonneg CHECK (stock_quantity >= 0) NOT VALID;
ALTER TABLE public.inventory VALIDATE CONSTRAINT inventory_stock_quantity_nonneg;
ALTER TABLE public.inventory ADD CONSTRAINT inventory_sold_quantity_nonneg CHECK (sold_quantity >= 0) NOT VALID;
ALTER TABLE public.inventory VALIDATE CONSTRAINT inventory_sold_quantity_nonneg;
ALTER TABLE public.inventory ADD CONSTRAINT inventory_location_nonblank CHECK (location IS NULL OR btrim(location) <> '') NOT VALID;
ALTER TABLE public.inventory VALIDATE CONSTRAINT inventory_location_nonblank;

-- product_variants numeric authority
ALTER TABLE public.product_variants ALTER COLUMN stock_quantity SET NOT NULL;
ALTER TABLE public.product_variants ADD CONSTRAINT product_variants_stock_quantity_nonneg CHECK (stock_quantity >= 0) NOT VALID;
ALTER TABLE public.product_variants VALIDATE CONSTRAINT product_variants_stock_quantity_nonneg;

-- shelf tables: non-negative quantity (transient 0 allowed), non-blank location
ALTER TABLE public.shelf_stock ADD CONSTRAINT shelf_stock_quantity_nonneg CHECK (quantity >= 0) NOT VALID;
ALTER TABLE public.shelf_stock VALIDATE CONSTRAINT shelf_stock_quantity_nonneg;
ALTER TABLE public.shelf_stock ADD CONSTRAINT shelf_stock_location_nonblank CHECK (btrim(location) <> '') NOT VALID;
ALTER TABLE public.shelf_stock VALIDATE CONSTRAINT shelf_stock_location_nonblank;

ALTER TABLE public.variant_shelf_stock ADD CONSTRAINT variant_shelf_stock_quantity_nonneg CHECK (quantity >= 0) NOT VALID;
ALTER TABLE public.variant_shelf_stock VALIDATE CONSTRAINT variant_shelf_stock_quantity_nonneg;
ALTER TABLE public.variant_shelf_stock ADD CONSTRAINT variant_shelf_stock_location_nonblank CHECK (btrim(location) <> '') NOT VALID;
ALTER TABLE public.variant_shelf_stock VALIDATE CONSTRAINT variant_shelf_stock_location_nonblank;

-- ============================================================================
-- 3) CANONICAL CROSS-TABLE INVARIANT — validate only, NEVER repair. INTERNAL.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.inv_assert_product_integrity(p_product_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_inv_cnt   integer;
  v_inv_id    uuid;
  v_stock     integer;
  v_sold      integer;
  v_loc       text;
  v_var_cnt   integer;
  v_var_sum   bigint;
  v_shelf_cnt integer;
  v_primary   text;
BEGIN
  IF p_product_id IS NULL THEN RETURN; END IF;
  -- Product gone (full delete / archive cascade) → nothing to assert.
  PERFORM 1 FROM products WHERE id = p_product_id;
  IF NOT FOUND THEN RETURN; END IF;

  -- A) exactly one inventory row
  SELECT count(*) INTO v_inv_cnt FROM inventory WHERE product_id = p_product_id;
  IF v_inv_cnt <> 1 THEN
    RAISE EXCEPTION 'inv_integrity[%]: expected exactly one inventory row, got %', p_product_id, v_inv_cnt;
  END IF;
  SELECT id, stock_quantity, sold_quantity, location
    INTO v_inv_id, v_stock, v_sold, v_loc FROM inventory WHERE product_id = p_product_id;

  -- B) inventory stock/sold valid
  IF v_stock IS NULL OR v_stock < 0 OR v_sold IS NULL OR v_sold < 0 THEN
    RAISE EXCEPTION 'inv_integrity[%]: malformed inventory stock/sold', p_product_id;
  END IF;

  SELECT count(*), coalesce(sum(stock_quantity), 0)
    INTO v_var_cnt, v_var_sum FROM product_variants WHERE parent_product_id = p_product_id;

  IF v_var_cnt > 0 THEN
    -- C) VARIANT product
    IF EXISTS (SELECT 1 FROM product_variants WHERE parent_product_id = p_product_id AND (stock_quantity IS NULL OR stock_quantity < 0)) THEN
      RAISE EXCEPTION 'inv_integrity[%]: malformed variant stock', p_product_id;
    END IF;
    IF v_stock <> v_var_sum THEN
      RAISE EXCEPTION 'inv_integrity[%]: parent rollup drift (inventory % <> Σ variants %)', p_product_id, v_stock, v_var_sum;
    END IF;
    IF v_loc IS NOT NULL THEN
      RAISE EXCEPTION 'inv_integrity[%]: variant parent inventory.location must be NULL', p_product_id;
    END IF;
    IF EXISTS (SELECT 1 FROM shelf_stock WHERE inventory_id = v_inv_id) THEN
      RAISE EXCEPTION 'inv_integrity[%]: variant product has product-level shelf rows', p_product_id;
    END IF;
    -- each variant that HAS variant-shelf rows: all committed qty > 0 AND Σ = variant stock
    IF EXISTS (
      SELECT 1 FROM product_variants pv
      JOIN (SELECT variant_id, sum(quantity) AS s, min(quantity) AS mn
              FROM variant_shelf_stock GROUP BY variant_id) x ON x.variant_id = pv.id
      WHERE pv.parent_product_id = p_product_id AND (x.mn <= 0 OR x.s <> pv.stock_quantity)
    ) THEN
      RAISE EXCEPTION 'inv_integrity[%]: variant shelf drift or committed zero row', p_product_id;
    END IF;
  ELSE
    -- D) SIMPLE product
    SELECT count(*) INTO v_shelf_cnt FROM shelf_stock WHERE inventory_id = v_inv_id;
    IF v_shelf_cnt > 0 THEN
      IF EXISTS (SELECT 1 FROM shelf_stock WHERE inventory_id = v_inv_id AND quantity <= 0) THEN
        RAISE EXCEPTION 'inv_integrity[%]: committed zero/negative shelf row', p_product_id;
      END IF;
      IF (SELECT coalesce(sum(quantity), 0) FROM shelf_stock WHERE inventory_id = v_inv_id) <> v_stock THEN
        RAISE EXCEPTION 'inv_integrity[%]: simple shelf sum drift', p_product_id;
      END IF;
      SELECT location INTO v_primary FROM shelf_stock WHERE inventory_id = v_inv_id
        ORDER BY quantity DESC, location ASC, id ASC LIMIT 1;
      IF v_loc IS DISTINCT FROM v_primary THEN
        RAISE EXCEPTION 'inv_integrity[%]: primary location drift (% <> %)', p_product_id, v_loc, v_primary;
      END IF;
    ELSE
      IF v_loc IS NOT NULL THEN
        RAISE EXCEPTION 'inv_integrity[%]: simple product with no shelves must have NULL location', p_product_id;
      END IF;
    END IF;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.inv_assert_product_integrity(uuid) FROM public;
REVOKE ALL ON FUNCTION public.inv_assert_product_integrity(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.inv_assert_product_integrity(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.inv_assert_product_integrity(uuid) FROM service_role;

-- ============================================================================
-- 4) DEFERRED CROSS-TABLE INVARIANT TRIGGERS (checked at TRANSACTION END).
--    A generic function resolves the affected product id(s) from NEW/OLD via
--    to_jsonb (so one function serves every table) and asserts each. Deferred so
--    a valid multi-step RPC (e.g. a sale that transiently zeroes then deletes a
--    shelf row) is only judged on its committed end-state. NEVER mutates.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.inv_integrity_check()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_new jsonb;
  v_old jsonb;
  v_pid uuid;
BEGIN
  IF TG_OP <> 'DELETE' THEN v_new := to_jsonb(NEW); END IF;
  IF TG_OP <> 'INSERT' THEN v_old := to_jsonb(OLD); END IF;

  IF TG_TABLE_NAME = 'products' THEN
    IF v_new IS NOT NULL THEN PERFORM inv_assert_product_integrity((v_new->>'id')::uuid); END IF;

  ELSIF TG_TABLE_NAME = 'inventory' THEN
    IF v_new IS NOT NULL THEN PERFORM inv_assert_product_integrity((v_new->>'product_id')::uuid); END IF;
    IF v_old IS NOT NULL AND (v_old->>'product_id') IS DISTINCT FROM (v_new->>'product_id') THEN
      PERFORM inv_assert_product_integrity((v_old->>'product_id')::uuid);
    END IF;

  ELSIF TG_TABLE_NAME = 'product_variants' THEN
    IF v_new IS NOT NULL THEN PERFORM inv_assert_product_integrity((v_new->>'parent_product_id')::uuid); END IF;
    IF v_old IS NOT NULL AND (v_old->>'parent_product_id') IS DISTINCT FROM (v_new->>'parent_product_id') THEN
      PERFORM inv_assert_product_integrity((v_old->>'parent_product_id')::uuid);
    END IF;

  ELSIF TG_TABLE_NAME = 'shelf_stock' THEN
    IF v_new IS NOT NULL THEN
      SELECT product_id INTO v_pid FROM inventory WHERE id = (v_new->>'inventory_id')::uuid;
      IF v_pid IS NOT NULL THEN PERFORM inv_assert_product_integrity(v_pid); END IF;
    END IF;
    IF v_old IS NOT NULL AND (v_old->>'inventory_id') IS DISTINCT FROM (v_new->>'inventory_id') THEN
      SELECT product_id INTO v_pid FROM inventory WHERE id = (v_old->>'inventory_id')::uuid;
      IF v_pid IS NOT NULL THEN PERFORM inv_assert_product_integrity(v_pid); END IF;
    END IF;

  ELSIF TG_TABLE_NAME = 'variant_shelf_stock' THEN
    IF v_new IS NOT NULL THEN
      SELECT parent_product_id INTO v_pid FROM product_variants WHERE id = (v_new->>'variant_id')::uuid;
      IF v_pid IS NOT NULL THEN PERFORM inv_assert_product_integrity(v_pid); END IF;
    END IF;
    IF v_old IS NOT NULL AND (v_old->>'variant_id') IS DISTINCT FROM (v_new->>'variant_id') THEN
      SELECT parent_product_id INTO v_pid FROM product_variants WHERE id = (v_old->>'variant_id')::uuid;
      IF v_pid IS NOT NULL THEN PERFORM inv_assert_product_integrity(v_pid); END IF;
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.inv_integrity_check() FROM public;
REVOKE ALL ON FUNCTION public.inv_integrity_check() FROM anon;
REVOKE ALL ON FUNCTION public.inv_integrity_check() FROM authenticated;
REVOKE ALL ON FUNCTION public.inv_integrity_check() FROM service_role;

DROP TRIGGER IF EXISTS trg_inv_integrity_products ON public.products;
CREATE CONSTRAINT TRIGGER trg_inv_integrity_products
  AFTER INSERT ON public.products
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.inv_integrity_check();

DROP TRIGGER IF EXISTS trg_inv_integrity_inventory ON public.inventory;
CREATE CONSTRAINT TRIGGER trg_inv_integrity_inventory
  AFTER INSERT OR UPDATE OR DELETE ON public.inventory
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.inv_integrity_check();

DROP TRIGGER IF EXISTS trg_inv_integrity_variants ON public.product_variants;
CREATE CONSTRAINT TRIGGER trg_inv_integrity_variants
  AFTER INSERT OR UPDATE OR DELETE ON public.product_variants
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.inv_integrity_check();

DROP TRIGGER IF EXISTS trg_inv_integrity_shelf ON public.shelf_stock;
CREATE CONSTRAINT TRIGGER trg_inv_integrity_shelf
  AFTER INSERT OR UPDATE OR DELETE ON public.shelf_stock
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.inv_integrity_check();

DROP TRIGGER IF EXISTS trg_inv_integrity_variant_shelf ON public.variant_shelf_stock;
CREATE CONSTRAINT TRIGGER trg_inv_integrity_variant_shelf
  AFTER INSERT OR UPDATE OR DELETE ON public.variant_shelf_stock
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.inv_integrity_check();

-- ============================================================================
-- 5) ACL LOCKDOWN — direct numeric/structural writes impossible for every role.
--    All mutation flows through the SECURITY DEFINER RPCs (owner-privileged).
-- ============================================================================

-- inventory: SELECT + metadata-only UPDATE (low_stock_threshold, updated_at).
REVOKE ALL ON TABLE public.inventory FROM anon;
REVOKE ALL ON TABLE public.inventory FROM authenticated;
REVOKE ALL ON TABLE public.inventory FROM service_role;
GRANT SELECT ON TABLE public.inventory TO authenticated, service_role;
GRANT UPDATE (low_stock_threshold, updated_at) ON TABLE public.inventory TO authenticated, service_role;

-- product_variants: SELECT + metadata/availability-only UPDATE (never stock_quantity/parent_product_id/id).
REVOKE ALL ON TABLE public.product_variants FROM anon;
REVOKE ALL ON TABLE public.product_variants FROM authenticated;
REVOKE ALL ON TABLE public.product_variants FROM service_role;
GRANT SELECT ON TABLE public.product_variants TO authenticated, service_role;
GRANT UPDATE (variant_name, variant_name_en, sku, barcode, color, size, price, stock_status)
  ON TABLE public.product_variants TO authenticated, service_role;

-- shelf tables: SELECT only — every mutation is via an Inventory RPC.
REVOKE ALL ON TABLE public.shelf_stock FROM anon;
REVOKE ALL ON TABLE public.shelf_stock FROM authenticated;
REVOKE ALL ON TABLE public.shelf_stock FROM service_role;
GRANT SELECT ON TABLE public.shelf_stock TO authenticated, service_role;

REVOKE ALL ON TABLE public.variant_shelf_stock FROM anon;
REVOKE ALL ON TABLE public.variant_shelf_stock FROM authenticated;
REVOKE ALL ON TABLE public.variant_shelf_stock FROM service_role;
GRANT SELECT ON TABLE public.variant_shelf_stock TO authenticated, service_role;

-- ============================================================================
-- 6) RLS POLICY CLEANUP — replace broad ALL/true policies with least privilege.
--    (Column limits are enforced by the ACL above; these gate row operations.)
-- ============================================================================
DROP POLICY IF EXISTS authenticated_all_inventory ON public.inventory;
DROP POLICY IF EXISTS authenticated_all_product_variants ON public.product_variants;
DROP POLICY IF EXISTS shelf_stock_rw ON public.shelf_stock;
DROP POLICY IF EXISTS variant_shelf_stock_rw ON public.variant_shelf_stock;

CREATE POLICY inventory_select ON public.inventory FOR SELECT TO authenticated USING (true);
CREATE POLICY inventory_meta_update ON public.inventory FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY product_variants_select ON public.product_variants FOR SELECT TO authenticated USING (true);
CREATE POLICY product_variants_meta_update ON public.product_variants FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY shelf_stock_select ON public.shelf_stock FOR SELECT TO authenticated USING (true);
CREATE POLICY variant_shelf_stock_select ON public.variant_shelf_stock FOR SELECT TO authenticated USING (true);

-- ============================================================================
-- 7) sync_product_variants FINAL LOCKDOWN — service_role only.
--    The editor runtime now calls it with the service-role/admin client.
-- ============================================================================
REVOKE EXECUTE ON FUNCTION public.sync_product_variants(uuid, jsonb) FROM authenticated;

-- ============================================================================
-- 8) SECURITY DEFINER search_path normalization → public, pg_temp.
--    Pure ALTER (no body rewrite). Covers every inventory-related definer fn that
--    isn't already normalized. Internal primitives stay service_role-inaccessible;
--    Engine/order/archive entrypoints keep their existing service_role-only grants.
-- ============================================================================
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid, p.proname, pg_get_function_identity_arguments(p.oid) AS args
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prosecdef
       AND ( p.proname LIKE 'inv\_%' ESCAPE '\'
             OR p.proname IN ('sync_product_variants','archive_product_bundle','restore_product_archive',
                              'process_shopify_order_deduction','process_talabat_order_deduction') )
       AND coalesce(array_to_string(p.proconfig, ','), '') NOT LIKE '%search_path=public, pg_temp%'
  LOOP
    EXECUTE format('ALTER FUNCTION public.%I(%s) SET search_path = public, pg_temp', r.proname, r.args);
  END LOOP;
END $$;
