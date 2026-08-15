-- ============================================================================
-- INV.6A — Runtime Closure + Strict-Enforcement FOUNDATION.
--
-- ADDITIVE / backward-compatible with the CURRENTLY deployed runtime. It may be
-- applied to production BEFORE the INV.6A code merge (the new atomic movement
-- RPCs sit unused until the new runtime ships; the FKs + uniqueness match the
-- already-clean production state verified read-only).
--
-- Contains ONLY:
--   A) structural foreign keys for the two shelf tables (ON DELETE CASCADE),
--   B) UNIQUE (product_id) on inventory (exactly-one-inventory foundation),
--   C) inv_apply_simple_delta — INTERNAL atomic simple-product movement primitive,
--   D) four SECURITY DEFINER movement RPCs built on that primitive
--      (record / edit / delete / reverse), service_role only.
--
-- It DOES NOT contain (those belong to INV.6B, AFTER the new runtime deploys):
--   NOT NULL / CHECK constraints, strict RLS policy replacement, table/column
--   privilege revocations, or global cross-table invariant triggers.
--
-- 2147483647 = max int4. malak_audit is this project's stock-movement ledger
-- (id bigint). Availability (stock_status) is NEVER read or written here; the
-- retired products.stock_quantity mirror is NEVER touched.
-- ============================================================================

-- ============================================================================
-- A) SHELF FOREIGN KEYS — structural integrity (orphans verified = 0 read-only).
--    Safe pattern: ADD ... NOT VALID (no full-table scan / lock escalation),
--    then VALIDATE in a second step (succeeds because there are no orphans).
--    Deterministic constraint names. Guarded so a re-apply is a no-op.
-- ============================================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'shelf_stock_inventory_id_fkey'
      AND conrelid = 'public.shelf_stock'::regclass
  ) THEN
    ALTER TABLE public.shelf_stock
      ADD CONSTRAINT shelf_stock_inventory_id_fkey
      FOREIGN KEY (inventory_id) REFERENCES public.inventory(id) ON DELETE CASCADE NOT VALID;
    ALTER TABLE public.shelf_stock VALIDATE CONSTRAINT shelf_stock_inventory_id_fkey;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'variant_shelf_stock_variant_id_fkey'
      AND conrelid = 'public.variant_shelf_stock'::regclass
  ) THEN
    ALTER TABLE public.variant_shelf_stock
      ADD CONSTRAINT variant_shelf_stock_variant_id_fkey
      FOREIGN KEY (variant_id) REFERENCES public.product_variants(id) ON DELETE CASCADE NOT VALID;
    ALTER TABLE public.variant_shelf_stock VALIDATE CONSTRAINT variant_shelf_stock_variant_id_fkey;
  END IF;
END $$;

-- ============================================================================
-- B) EXACTLY-ONE-INVENTORY FOUNDATION — UNIQUE (product_id) on inventory.
--    Production has 0 duplicate product inventory rows (verified read-only), so
--    the unique index builds cleanly. Explicitly named. Guarded for re-apply.
-- ============================================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inventory_product_id_key'
      AND conrelid = 'public.inventory'::regclass
  ) THEN
    ALTER TABLE public.inventory
      ADD CONSTRAINT inventory_product_id_key UNIQUE (product_id);
  END IF;
END $$;

-- ============================================================================
-- C) inv_apply_simple_delta — INTERNAL atomic simple-product movement primitive.
--
-- The SOLE numeric writer for a manual product-grain (simple product) movement.
-- Locks exactly one inventory row, validates the grain fail-closed, applies the
-- delta (and, for a sale-out, the matching sold increment) in BIGINT with
-- int4-overflow + underflow protection, and returns authoritative before/after.
-- It writes NO audit (the outer RPC owns the ledger), NO availability, and never
-- the products mirror. INTERNAL: revoked from PUBLIC/anon/authenticated AND
-- service_role — only the SECURITY DEFINER outer RPCs (same owner) may call it.
--
-- Sold contract (record semantics): p_sold_delta must be 0, OR exactly -p_delta
-- for a sale-out (p_delta < 0). Anything else is sold_delta_mismatch.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.inv_apply_simple_delta(
  p_inventory_id uuid,
  p_delta        integer,
  p_sold_delta   integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_pid         uuid;
  v_before      integer;
  v_sold_before integer;
  v_after       bigint;
  v_sold_after  bigint;
  v_rows        integer;
BEGIN
  IF p_inventory_id IS NULL THEN RETURN jsonb_build_object('status','error','reason','invalid_target'); END IF;
  IF p_delta IS NULL OR p_delta = 0 THEN RETURN jsonb_build_object('status','error','reason','invalid_delta'); END IF;
  IF p_sold_delta IS NULL OR p_sold_delta < 0 THEN RETURN jsonb_build_object('status','error','reason','invalid_sold_delta'); END IF;
  -- sold may advance ONLY as the exact mirror of a sale-out.
  IF p_sold_delta > 0 AND NOT (p_delta < 0 AND p_sold_delta = -p_delta) THEN
    RETURN jsonb_build_object('status','error','reason','sold_delta_mismatch');
  END IF;

  -- Lock exactly one inventory row; resolve its product.
  SELECT product_id, stock_quantity, sold_quantity
    INTO v_pid, v_before, v_sold_before
    FROM inventory WHERE id = p_inventory_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','error','reason','missing_inventory'); END IF;

  -- Grain guards: a simple product only — no variants, no product-level shelves.
  IF EXISTS (SELECT 1 FROM product_variants WHERE parent_product_id = v_pid) THEN
    RETURN jsonb_build_object('status','error','reason','product_has_variants');
  END IF;
  IF EXISTS (SELECT 1 FROM shelf_stock WHERE inventory_id = p_inventory_id) THEN
    RETURN jsonb_build_object('status','error','reason','product_has_shelf_rows');
  END IF;

  -- Authoritative current state must be well-formed.
  IF v_before IS NULL OR v_before < 0 THEN RETURN jsonb_build_object('status','error','reason','inventory_inconsistent'); END IF;
  IF v_sold_before IS NULL OR v_sold_before < 0 THEN RETURN jsonb_build_object('status','error','reason','inventory_inconsistent'); END IF;

  -- BIGINT arithmetic; no clamp; underflow / overflow fail closed.
  v_after      := v_before::bigint + p_delta::bigint;
  v_sold_after := v_sold_before::bigint + p_sold_delta::bigint;
  IF v_after < 0 THEN RETURN jsonb_build_object('status','error','reason','insufficient_stock'); END IF;
  IF v_after > 2147483647 OR v_sold_after > 2147483647 THEN
    RETURN jsonb_build_object('status','error','reason','overflow');
  END IF;

  UPDATE inventory
     SET stock_quantity = v_after::int, sold_quantity = v_sold_after::int, updated_at = now()
   WHERE id = p_inventory_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN RAISE EXCEPTION 'inv_apply_simple_delta rowcount %', v_rows; END IF;

  RETURN jsonb_build_object(
    'status','applied','productId',v_pid,'inventoryId',p_inventory_id,
    'before',v_before,'after',v_after::int,'soldBefore',v_sold_before,'soldAfter',v_sold_after::int);
END;
$$;

REVOKE ALL ON FUNCTION public.inv_apply_simple_delta(uuid, integer, integer) FROM public;
REVOKE ALL ON FUNCTION public.inv_apply_simple_delta(uuid, integer, integer) FROM anon;
REVOKE ALL ON FUNCTION public.inv_apply_simple_delta(uuid, integer, integer) FROM authenticated;
REVOKE ALL ON FUNCTION public.inv_apply_simple_delta(uuid, integer, integer) FROM service_role;

-- ============================================================================
-- Shared movement-guard helper: lock a manual product movement audit row and
-- classify why it cannot be mutated. Returns the row via OUT params. INTERNAL.
-- (Inlined into each RPC below rather than a separate function to keep the audit
-- row lock inside the caller's transaction with no extra grant surface.)
-- ============================================================================

-- ============================================================================
-- D1) inv_record_product_movement — record a manual IN/OUT (service_role only).
-- ============================================================================
CREATE OR REPLACE FUNCTION public.inv_record_product_movement(
  p_inventory_id uuid,
  p_direction    text,
  p_quantity     integer,
  p_reason       text,
  p_note         text,
  p_actor        text,
  p_sku          text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_delta      integer;
  v_sold_delta integer;
  v_reason     text;
  v_prim       jsonb;
  v_audit_id   bigint;
BEGIN
  IF p_direction NOT IN ('in','out') THEN RETURN jsonb_build_object('status','error','reason','invalid_direction'); END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 OR p_quantity > 2147483647 THEN
    RETURN jsonb_build_object('status','error','reason','invalid_quantity');
  END IF;

  -- Canonical reason: exact "sale" (case-insensitive) → 'sale'; else trimmed text or null.
  IF p_reason IS NOT NULL AND lower(btrim(p_reason)) = 'sale' THEN
    v_reason := 'sale';
  ELSE
    v_reason := nullif(btrim(coalesce(p_reason, '')), '');
  END IF;

  v_delta := CASE WHEN p_direction = 'in' THEN p_quantity ELSE -p_quantity END;
  v_sold_delta := CASE WHEN p_direction = 'out' AND v_reason = 'sale' THEN p_quantity ELSE 0 END;

  -- Numeric mutation via the sole primitive (fail-closed classified reason).
  v_prim := public.inv_apply_simple_delta(p_inventory_id, v_delta, v_sold_delta);
  IF (v_prim ->> 'status') IS DISTINCT FROM 'applied' THEN
    RETURN v_prim;
  END IF;

  -- Audit ledger row in the SAME transaction (a failure rolls back the stock).
  INSERT INTO malak_audit (action_type, agent, sku, product_id, field, old_value, new_value, details, status)
  VALUES (
    CASE WHEN p_direction = 'in' THEN 'stock_in' ELSE 'stock_out' END,
    p_actor, p_sku, (v_prim ->> 'productId')::uuid, 'stock_quantity',
    v_prim ->> 'before', v_prim ->> 'after',
    jsonb_build_object(
      'productId', (v_prim ->> 'productId')::uuid,
      'inventoryId', p_inventory_id,
      'quantity', p_quantity,
      'direction', p_direction,
      'reason', v_reason,
      'note', nullif(btrim(coalesce(p_note, '')), ''),
      'by', p_actor),
    'done')
  RETURNING id INTO v_audit_id;

  RETURN jsonb_build_object(
    'status','applied','auditId',v_audit_id,
    'productId',(v_prim ->> 'productId')::uuid,'inventoryId',p_inventory_id,
    'before',(v_prim ->> 'before')::int,'after',(v_prim ->> 'after')::int,
    'soldBefore',(v_prim ->> 'soldBefore')::int,'soldAfter',(v_prim ->> 'soldAfter')::int,
    'quantity',p_quantity,'direction',p_direction,'reason',v_reason);
END;
$$;

REVOKE ALL ON FUNCTION public.inv_record_product_movement(uuid, text, integer, text, text, text, text) FROM public;
REVOKE ALL ON FUNCTION public.inv_record_product_movement(uuid, text, integer, text, text, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.inv_record_product_movement(uuid, text, integer, text, text, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.inv_record_product_movement(uuid, text, integer, text, text, text, text) TO service_role;

-- ============================================================================
-- D2) inv_edit_product_movement — change a recorded movement's quantity.
--
-- Locks the audit row first, enforces the SAME channel-immutability rule as
-- INV.5 (details.immutable = true OR details.source in shopify/talabat), rejects
-- reversed/deleted rows and non-product-movement rows, then applies the stock
-- (and sold, for a canonical sale-out) delta between old and new quantity with
-- NO clamp — underflow/overflow fail closed. Records editHistory; never a second
-- audit row. All-or-nothing in one transaction.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.inv_edit_product_movement(
  p_audit_id     bigint,
  p_new_quantity integer,
  p_actor        text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row        record;
  v_dir        text;
  v_reason     text;
  v_old_qty    integer;
  v_inv_id     uuid;
  v_pid        uuid;
  v_stock      integer;
  v_sold       integer;
  v_delta_qty  integer;
  v_stock_delta integer;
  v_stock_after bigint;
  v_sold_after  bigint;
  v_old_val    bigint;
  v_new_val    text;
  v_rows       integer;
  v_details    jsonb;
  v_hist       jsonb;
BEGIN
  IF p_new_quantity IS NULL OR p_new_quantity <= 0 OR p_new_quantity > 2147483647 THEN
    RETURN jsonb_build_object('status','error','reason','invalid_quantity');
  END IF;

  SELECT id, action_type, old_value, details INTO v_row
    FROM malak_audit WHERE id = p_audit_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','error','reason','movement_not_found'); END IF;

  -- Channel immutability (INV.5 canonical rule).
  IF coalesce((v_row.details ->> 'immutable')::boolean, false)
     OR (v_row.details ->> 'source') IN ('shopify','talabat') THEN
    RETURN jsonb_build_object('status','error','reason','movement_locked');
  END IF;

  IF v_row.action_type NOT IN ('stock_in','stock_out') THEN
    RETURN jsonb_build_object('status','error','reason','not_a_product_movement');
  END IF;
  IF (v_row.details ->> 'review') = 'reversed' THEN RETURN jsonb_build_object('status','error','reason','movement_reversed'); END IF;
  IF (v_row.details ->> 'review') = 'deleted'  THEN RETURN jsonb_build_object('status','error','reason','movement_deleted'); END IF;

  v_inv_id  := nullif(v_row.details ->> 'inventoryId','')::uuid;
  v_old_qty := nullif(v_row.details ->> 'quantity','')::int;
  IF v_inv_id IS NULL OR v_old_qty IS NULL OR v_old_qty <= 0 THEN
    RETURN jsonb_build_object('status','error','reason','movement_details_missing');
  END IF;
  v_dir    := CASE WHEN v_row.action_type = 'stock_in' THEN 'in' ELSE 'out' END;
  v_reason := v_row.details ->> 'reason';

  IF p_new_quantity = v_old_qty THEN
    RETURN jsonb_build_object('status','applied','auditId',p_audit_id,'quantity',v_old_qty,'noop',true);
  END IF;

  -- Lock the authoritative inventory row; reject variant / shelf / malformed.
  SELECT product_id, stock_quantity, sold_quantity INTO v_pid, v_stock, v_sold
    FROM inventory WHERE id = v_inv_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','error','reason','missing_inventory'); END IF;
  IF EXISTS (SELECT 1 FROM product_variants WHERE parent_product_id = v_pid) THEN
    RETURN jsonb_build_object('status','error','reason','product_has_variants');
  END IF;
  IF EXISTS (SELECT 1 FROM shelf_stock WHERE inventory_id = v_inv_id) THEN
    RETURN jsonb_build_object('status','error','reason','product_has_shelf_rows');
  END IF;
  IF v_stock IS NULL OR v_stock < 0 OR v_sold IS NULL OR v_sold < 0 THEN
    RETURN jsonb_build_object('status','error','reason','inventory_inconsistent');
  END IF;

  v_delta_qty   := p_new_quantity - v_old_qty;                        -- change in movement size
  v_stock_delta := CASE WHEN v_dir = 'in' THEN v_delta_qty ELSE -v_delta_qty END;
  v_stock_after := v_stock::bigint + v_stock_delta::bigint;
  IF v_stock_after < 0 THEN RETURN jsonb_build_object('status','error','reason','insufficient_stock'); END IF;
  IF v_stock_after > 2147483647 THEN RETURN jsonb_build_object('status','error','reason','overflow'); END IF;

  -- Canonical sale-out: sold follows the quantity delta exactly.
  IF v_dir = 'out' AND v_reason = 'sale' THEN
    v_sold_after := v_sold::bigint + v_delta_qty::bigint;
    IF v_sold_after < 0 THEN RETURN jsonb_build_object('status','error','reason','sold_inconsistent'); END IF;
    IF v_sold_after > 2147483647 THEN RETURN jsonb_build_object('status','error','reason','overflow'); END IF;
    UPDATE inventory SET stock_quantity = v_stock_after::int, sold_quantity = v_sold_after::int, updated_at = now()
     WHERE id = v_inv_id;
  ELSE
    UPDATE inventory SET stock_quantity = v_stock_after::int, updated_at = now()
     WHERE id = v_inv_id;
  END IF;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN RAISE EXCEPTION 'inv_edit_product_movement rowcount %', v_rows; END IF;

  -- Recompute audit new_value from the numeric old_value, if it was numeric.
  BEGIN v_old_val := v_row.old_value::bigint; EXCEPTION WHEN OTHERS THEN v_old_val := NULL; END;
  IF v_old_val IS NOT NULL THEN
    v_new_val := (v_old_val + CASE WHEN v_dir = 'in' THEN p_new_quantity ELSE -p_new_quantity END)::text;
  END IF;

  v_hist := coalesce(v_row.details -> 'editHistory', '[]'::jsonb)
            || jsonb_build_array(jsonb_build_object('by',p_actor,'at',now(),'from',v_old_qty,'to',p_new_quantity));
  v_details := coalesce(v_row.details, '{}'::jsonb)
               || jsonb_build_object('quantity', p_new_quantity,
                                     'edited', jsonb_build_object('by',p_actor,'at',now(),'from',v_old_qty,'to',p_new_quantity),
                                     'editHistory', v_hist);

  UPDATE malak_audit
     SET details = v_details,
         new_value = coalesce(v_new_val, new_value)
   WHERE id = p_audit_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN RAISE EXCEPTION 'inv_edit_product_movement audit rowcount %', v_rows; END IF;

  RETURN jsonb_build_object('status','applied','auditId',p_audit_id,'quantity',p_new_quantity,
    'productId',v_pid,'inventoryId',v_inv_id,'stockBefore',v_stock,'stockAfter',v_stock_after::int);
END;
$$;

REVOKE ALL ON FUNCTION public.inv_edit_product_movement(bigint, integer, text) FROM public;
REVOKE ALL ON FUNCTION public.inv_edit_product_movement(bigint, integer, text) FROM anon;
REVOKE ALL ON FUNCTION public.inv_edit_product_movement(bigint, integer, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.inv_edit_product_movement(bigint, integer, text) TO service_role;

-- ============================================================================
-- D3) inv_delete_product_movement — undo a recorded movement's stock effect and
-- mark the audit row deleted (kept visible). Same immutability rule. No clamp:
-- deleting an IN needs enough CURRENT stock (else cannot_undo_consumed_stock);
-- deleting a sale-OUT restores stock AND lowers sold (else sold_inconsistent).
-- ============================================================================
CREATE OR REPLACE FUNCTION public.inv_delete_product_movement(
  p_audit_id bigint,
  p_actor    text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row         record;
  v_dir         text;
  v_reason      text;
  v_qty         integer;
  v_inv_id      uuid;
  v_pid         uuid;
  v_stock       integer;
  v_sold        integer;
  v_stock_delta integer;
  v_stock_after bigint;
  v_sold_after  bigint;
  v_rows        integer;
  v_review      text;
BEGIN
  SELECT id, action_type, details INTO v_row
    FROM malak_audit WHERE id = p_audit_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','error','reason','movement_not_found'); END IF;

  IF coalesce((v_row.details ->> 'immutable')::boolean, false)
     OR (v_row.details ->> 'source') IN ('shopify','talabat') THEN
    RETURN jsonb_build_object('status','error','reason','movement_locked');
  END IF;
  IF v_row.action_type NOT IN ('stock_in','stock_out') THEN
    RETURN jsonb_build_object('status','error','reason','not_a_product_movement');
  END IF;

  v_review := v_row.details ->> 'review';
  IF v_review = 'deleted' THEN RETURN jsonb_build_object('status','error','reason','already_deleted'); END IF;

  v_inv_id := nullif(v_row.details ->> 'inventoryId','')::uuid;
  v_qty    := nullif(v_row.details ->> 'quantity','')::int;
  v_dir    := CASE WHEN v_row.action_type = 'stock_in' THEN 'in' ELSE 'out' END;
  v_reason := v_row.details ->> 'reason';

  -- Apply the stock inversion ONLY when the movement still holds its effect
  -- (not already reversed) and its details are intact.
  IF v_review IS DISTINCT FROM 'reversed' AND v_inv_id IS NOT NULL AND v_qty IS NOT NULL AND v_qty > 0 THEN
    SELECT product_id, stock_quantity, sold_quantity INTO v_pid, v_stock, v_sold
      FROM inventory WHERE id = v_inv_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('status','error','reason','missing_inventory'); END IF;
    IF EXISTS (SELECT 1 FROM product_variants WHERE parent_product_id = v_pid) THEN
      RETURN jsonb_build_object('status','error','reason','product_has_variants');
    END IF;
    IF EXISTS (SELECT 1 FROM shelf_stock WHERE inventory_id = v_inv_id) THEN
      RETURN jsonb_build_object('status','error','reason','product_has_shelf_rows');
    END IF;
    IF v_stock IS NULL OR v_stock < 0 OR v_sold IS NULL OR v_sold < 0 THEN
      RETURN jsonb_build_object('status','error','reason','inventory_inconsistent');
    END IF;

    -- Undo: an IN comes back OUT (needs current stock); an OUT goes back IN.
    v_stock_delta := CASE WHEN v_dir = 'in' THEN -v_qty ELSE v_qty END;
    v_stock_after := v_stock::bigint + v_stock_delta::bigint;
    IF v_stock_after < 0 THEN RETURN jsonb_build_object('status','error','reason','cannot_undo_consumed_stock'); END IF;
    IF v_stock_after > 2147483647 THEN RETURN jsonb_build_object('status','error','reason','overflow'); END IF;

    IF v_dir = 'out' AND v_reason = 'sale' THEN
      v_sold_after := v_sold::bigint - v_qty::bigint;
      IF v_sold_after < 0 THEN RETURN jsonb_build_object('status','error','reason','sold_inconsistent'); END IF;
      UPDATE inventory SET stock_quantity = v_stock_after::int, sold_quantity = v_sold_after::int, updated_at = now()
       WHERE id = v_inv_id;
    ELSE
      UPDATE inventory SET stock_quantity = v_stock_after::int, updated_at = now()
       WHERE id = v_inv_id;
    END IF;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN RAISE EXCEPTION 'inv_delete_product_movement rowcount %', v_rows; END IF;
  END IF;

  UPDATE malak_audit
     SET details = coalesce(details, '{}'::jsonb)
                   || jsonb_build_object('review','deleted','deletedBy',p_actor,'deletedAt',now())
   WHERE id = p_audit_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN RAISE EXCEPTION 'inv_delete_product_movement audit rowcount %', v_rows; END IF;

  RETURN jsonb_build_object('status','applied','auditId',p_audit_id,'reviewed','deleted')
    || CASE WHEN v_stock IS NOT NULL AND v_stock_after IS NOT NULL
            THEN jsonb_build_object('stockBefore', v_stock, 'stockAfter', v_stock_after::int, 'productId', v_pid)
            ELSE '{}'::jsonb END;
END;
$$;

REVOKE ALL ON FUNCTION public.inv_delete_product_movement(bigint, text) FROM public;
REVOKE ALL ON FUNCTION public.inv_delete_product_movement(bigint, text) FROM anon;
REVOKE ALL ON FUNCTION public.inv_delete_product_movement(bigint, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.inv_delete_product_movement(bigint, text) TO service_role;

-- ============================================================================
-- D4) inv_reverse_product_movement — apply the exact inverse of a movement and
-- mark the original reversed. Inserts a distinct opposite audit row in the SAME
-- transaction, tagged immutable/source=movement_reversal so it is never itself
-- editable/pending. Same immutability rule; rejects deleted / already-reversed.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.inv_reverse_product_movement(
  p_audit_id bigint,
  p_actor    text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row         record;
  v_dir         text;
  v_reason      text;
  v_qty         integer;
  v_inv_id      uuid;
  v_pid         uuid;
  v_sku         text;
  v_stock       integer;
  v_sold        integer;
  v_stock_delta integer;
  v_stock_after bigint;
  v_sold_after  bigint;
  v_rows        integer;
  v_rev_id      bigint;
  v_rev_action  text;
BEGIN
  SELECT id, action_type, sku, details INTO v_row
    FROM malak_audit WHERE id = p_audit_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','error','reason','movement_not_found'); END IF;

  IF coalesce((v_row.details ->> 'immutable')::boolean, false)
     OR (v_row.details ->> 'source') IN ('shopify','talabat') THEN
    RETURN jsonb_build_object('status','error','reason','movement_locked');
  END IF;
  IF v_row.action_type NOT IN ('stock_in','stock_out') THEN
    RETURN jsonb_build_object('status','error','reason','not_a_product_movement');
  END IF;
  IF (v_row.details ->> 'review') = 'deleted'  THEN RETURN jsonb_build_object('status','error','reason','movement_deleted'); END IF;
  IF (v_row.details ->> 'review') = 'reversed' THEN RETURN jsonb_build_object('status','error','reason','already_reversed'); END IF;

  v_inv_id := nullif(v_row.details ->> 'inventoryId','')::uuid;
  v_qty    := nullif(v_row.details ->> 'quantity','')::int;
  IF v_inv_id IS NULL OR v_qty IS NULL OR v_qty <= 0 THEN
    RETURN jsonb_build_object('status','error','reason','movement_details_missing');
  END IF;
  v_dir    := CASE WHEN v_row.action_type = 'stock_in' THEN 'in' ELSE 'out' END;
  v_reason := v_row.details ->> 'reason';

  SELECT product_id, stock_quantity, sold_quantity INTO v_pid, v_stock, v_sold
    FROM inventory WHERE id = v_inv_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','error','reason','missing_inventory'); END IF;
  IF EXISTS (SELECT 1 FROM product_variants WHERE parent_product_id = v_pid) THEN
    RETURN jsonb_build_object('status','error','reason','product_has_variants');
  END IF;
  IF EXISTS (SELECT 1 FROM shelf_stock WHERE inventory_id = v_inv_id) THEN
    RETURN jsonb_build_object('status','error','reason','product_has_shelf_rows');
  END IF;
  IF v_stock IS NULL OR v_stock < 0 OR v_sold IS NULL OR v_sold < 0 THEN
    RETURN jsonb_build_object('status','error','reason','inventory_inconsistent');
  END IF;

  -- Inverse: reverse an IN by removing (needs current stock); reverse an OUT by adding.
  v_stock_delta := CASE WHEN v_dir = 'in' THEN -v_qty ELSE v_qty END;
  v_stock_after := v_stock::bigint + v_stock_delta::bigint;
  IF v_stock_after < 0 THEN RETURN jsonb_build_object('status','error','reason','cannot_undo_consumed_stock'); END IF;
  IF v_stock_after > 2147483647 THEN RETURN jsonb_build_object('status','error','reason','overflow'); END IF;

  IF v_dir = 'out' AND v_reason = 'sale' THEN
    v_sold_after := v_sold::bigint - v_qty::bigint;
    IF v_sold_after < 0 THEN RETURN jsonb_build_object('status','error','reason','sold_inconsistent'); END IF;
    UPDATE inventory SET stock_quantity = v_stock_after::int, sold_quantity = v_sold_after::int, updated_at = now()
     WHERE id = v_inv_id;
  ELSE
    UPDATE inventory SET stock_quantity = v_stock_after::int, updated_at = now()
     WHERE id = v_inv_id;
  END IF;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN RAISE EXCEPTION 'inv_reverse_product_movement rowcount %', v_rows; END IF;

  -- Distinct opposite audit row (immutable so it never becomes editable/pending).
  v_rev_action := CASE WHEN v_dir = 'in' THEN 'stock_out' ELSE 'stock_in' END;
  INSERT INTO malak_audit (action_type, agent, sku, product_id, field, old_value, new_value, details, status)
  VALUES (v_rev_action, p_actor, v_row.sku, v_pid, 'stock_quantity', v_stock::text, v_stock_after::text,
          jsonb_build_object('productId',v_pid,'inventoryId',v_inv_id,'quantity',v_qty,
                             'direction', CASE WHEN v_dir = 'in' THEN 'out' ELSE 'in' END,
                             'reason','movement_reversal','source','movement_reversal',
                             'originalAuditId',p_audit_id,'immutable',true,'by',p_actor),
          'done')
  RETURNING id INTO v_rev_id;

  UPDATE malak_audit
     SET details = coalesce(details, '{}'::jsonb)
                   || jsonb_build_object('review','reversed','reviewedBy',p_actor,'reviewedAt',now(),'reversalAuditId',v_rev_id)
   WHERE id = p_audit_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN RAISE EXCEPTION 'inv_reverse_product_movement audit rowcount %', v_rows; END IF;

  RETURN jsonb_build_object('status','applied','auditId',p_audit_id,'reversalAuditId',v_rev_id,
    'productId',v_pid,'inventoryId',v_inv_id,'before',v_stock,'after',v_stock_after::int);
END;
$$;

REVOKE ALL ON FUNCTION public.inv_reverse_product_movement(bigint, text) FROM public;
REVOKE ALL ON FUNCTION public.inv_reverse_product_movement(bigint, text) FROM anon;
REVOKE ALL ON FUNCTION public.inv_reverse_product_movement(bigint, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.inv_reverse_product_movement(bigint, text) TO service_role;
