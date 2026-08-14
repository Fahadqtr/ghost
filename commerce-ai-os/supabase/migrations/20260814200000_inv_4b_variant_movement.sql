-- ============================================================================
-- INV.4B — atomic variant MOVEMENT (stock ± + parent rollup + optional sold).
--
-- inv_adjust_variant_movement(p_variant_id uuid, p_delta integer,
--                             p_sold_delta integer) → jsonb
--
-- Applies a ± delta to ONE variant's stock, rolls the parent inventory up to
-- Σ variants, and — ONLY for a sale-out — increments inventory.sold_quantity by
-- the same magnitude, all in ONE transaction. It is the movement primitive
-- behind engine.adjustVariantMovement, used by the migrated variant movement
-- writers (recordVariantMovement, staffMoveVariant) in INV.4B. Modeled on the
-- INV.3C inv_adjust_variant (PASS-1 verify → PASS-2 apply); one transaction.
--
-- WHY A NEW RPC (not inv_adjust_variant + a separate sold update): the legacy
-- recordVariantMovement bumped inventory.sold_quantity on a "sale" out in the
-- SAME logical write as the stock change. Splitting that across inv_adjust_variant
-- and a follow-up inventory.update would break atomicity (a crash between the two
-- desyncs sold vs stock). This RPC keeps stock + rollup + sold ATOMIC. The old
-- inv_adjust_variant signature is UNCHANGED (still used where there is no sold
-- semantics).
--
-- SOLD CONTRACT (enforced in PASS-1):
--   p_sold_delta = 0                                  → no sold mutation, OR
--   p_delta < 0 AND p_sold_delta = abs(p_delta)       → a sale-out; sold += qty.
--   Anything else (sold on a stock-IN, or sold ≠ qty out) → 'sold_delta_mismatch'.
--   sold_quantity is fail-closed (NULL / negative → 'sold_inconsistent') ONLY when
--   p_sold_delta > 0 — a non-sale movement is never blocked by a dirty sold column.
--
-- GUARANTEES (identical safety envelope to INV.3C/4A):
--   * PASS-1 does all validation + deterministic FOR UPDATE locking (siblings in
--     (sku, id) order, then the parent inventory row) with NO write; PASS-2 applies
--     inside a subtransaction and every UPDATE asserts GET DIAGNOSTICS ROW_COUNT = 1,
--     so any anomaly rolls the whole apply back → {status:error, reason:apply_failed}.
--   * FAIL-CLOSED: a NULL / negative / malformed variant stock or rollup sibling
--     returns {status:error} and mutates nothing (never coalesced to 0).
--   * NO NEGATIVE STOCK — a resulting variant stock below zero → 'insufficient_stock'.
--   * SHELF FAIL-CLOSED — a variant WITH variant_shelf_stock → 'variant_has_shelf_rows'
--     (change it through the shelf RPC); a parent WITH product-level shelf_stock →
--     'parent_has_shelf_rows'. No shelf row is touched here.
--   * authoritative parentBefore = Σ variants BEFORE (siblings locked); parentStock
--     = Σ variants AFTER. Parent rollup is Σ variants — NEVER products.stock_quantity,
--     NEVER max().
--   * Writes ONLY product_variants.stock_quantity, inventory.stock_quantity, and
--     (sale-out only) inventory.sold_quantity + updated_at. NEVER products.stock_quantity
--     (stale mirror), NEVER stock_status / availability. NO stock task and NO audit row
--     inside SQL — the caller owns transitions + audit (the RPC returns before/after +
--     parentBefore/parentStock + soldBefore/soldAfter).
--
-- Idempotent (create or replace + guarded grants). 2147483647 = max int4.
-- ============================================================================

create or replace function public.inv_adjust_variant_movement(
  p_variant_id uuid,
  p_delta      integer,
  p_sold_delta integer
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pid            uuid;
  v_before         integer;
  v_after_big      bigint;
  v_after          integer;
  v_sibsum         bigint;
  v_parentbefore   bigint;
  v_parent_big     bigint;
  v_inv_id         uuid;
  v_cnt            integer;
  v_sum            bigint;
  v_sold           integer;
  v_sold_before    integer;
  v_sold_after_big bigint;
  v_sold_after     integer;
  v_rows           integer;
begin
  -- ---- arg validation --------------------------------------------------------
  if p_variant_id is null then
    return jsonb_build_object('status','error','reason','missing_variant');
  end if;
  -- A movement is a non-zero delta (a no-op movement is a caller bug).
  if p_delta is null or p_delta = 0 then
    return jsonb_build_object('status','error','reason','invalid_delta');
  end if;
  if p_sold_delta is null or p_sold_delta < 0 then
    return jsonb_build_object('status','error','reason','invalid_sold_delta');
  end if;
  -- sold may only accompany a stock-OUT, and must equal the quantity going out.
  if p_sold_delta > 0 and not (p_delta < 0 and p_sold_delta = abs(p_delta)) then
    return jsonb_build_object('status','error','reason','sold_delta_mismatch');
  end if;

  -- ---- PASS 1: resolve + lock (deterministic) + verify (no writes) -----------
  select parent_product_id into v_pid from product_variants where id = p_variant_id;
  if not found then
    return jsonb_build_object('status','error','reason','missing_variant');
  end if;
  if v_pid is null then
    return jsonb_build_object('status','error','reason','missing_parent');
  end if;

  -- Lock ALL sibling variants of the parent in a fixed (sku, id) order BEFORE the
  -- parent inventory row — matches the INV.3C / Talabat lock sequence.
  perform 1 from product_variants where parent_product_id = v_pid order by sku, id for update;

  -- Fail-closed rollup precheck: no sibling may be NULL / negative.
  if exists (select 1 from product_variants
               where parent_product_id = v_pid and (stock_quantity is null or stock_quantity < 0)) then
    return jsonb_build_object('status','error','reason','inventory_inconsistent');
  end if;

  select stock_quantity into v_before from product_variants where id = p_variant_id;
  if v_before is null or v_before < 0 then
    return jsonb_build_object('status','error','reason','inventory_inconsistent');
  end if;

  -- Shelf-tracked variant → cannot reconcile a bare delta (INV.3C decision).
  if exists (select 1 from variant_shelf_stock where variant_id = p_variant_id) then
    return jsonb_build_object('status','error','reason','variant_has_shelf_rows');
  end if;

  -- Resulting stock: bigint math to detect overflow / underflow before int4 cast.
  v_after_big := v_before::bigint + p_delta::bigint;
  if v_after_big < 0 then
    return jsonb_build_object('status','error','reason','insufficient_stock');
  end if;
  if v_after_big > 2147483647 then
    return jsonb_build_object('status','error','reason','overflow');
  end if;
  v_after := v_after_big::int;

  -- Exactly one parent inventory row; lock it and read its sold_quantity.
  select count(*) into v_cnt from inventory where product_id = v_pid;
  if v_cnt <> 1 then
    return jsonb_build_object('status','error','reason','inventory_inconsistent');
  end if;
  select id, sold_quantity into v_inv_id, v_sold from inventory where product_id = v_pid for update;

  -- A product-level shelf on the parent would desync on a variant rollup.
  if exists (select 1 from shelf_stock where inventory_id = v_inv_id) then
    return jsonb_build_object('status','error','reason','parent_has_shelf_rows');
  end if;

  -- Authoritative parent BEFORE = Σ variants BEFORE (siblings are locked).
  select coalesce(sum(stock_quantity),0) into v_parentbefore
    from product_variants where parent_product_id = v_pid;

  -- Parent AFTER rollup range check (other siblings + this variant's new stock).
  select coalesce(sum(stock_quantity),0) into v_sibsum
    from product_variants where parent_product_id = v_pid and id <> p_variant_id;
  v_parent_big := v_sibsum + v_after_big;
  if v_parent_big > 2147483647 then
    return jsonb_build_object('status','error','reason','overflow');
  end if;

  -- Sold: fail-closed read + overflow ONLY when a sale-out increments it.
  if p_sold_delta > 0 then
    if v_sold is null or v_sold < 0 then
      return jsonb_build_object('status','error','reason','sold_inconsistent');
    end if;
    v_sold_before := v_sold;
    v_sold_after_big := v_sold::bigint + p_sold_delta::bigint;
    if v_sold_after_big > 2147483647 then
      return jsonb_build_object('status','error','reason','overflow');
    end if;
    v_sold_after := v_sold_after_big::int;
  else
    -- No sold mutation; report current sold (lenient) for a deterministic response.
    v_sold_before := coalesce(v_sold, 0);
    v_sold_after  := v_sold_before;
  end if;

  -- ---- PASS 2: apply everything or nothing (subtransaction) ------------------
  begin
    update product_variants set stock_quantity = v_after where id = p_variant_id;
    get diagnostics v_rows = row_count;
    if v_rows <> 1 then raise exception 'inv4b_rowcount'; end if;

    select coalesce(sum(stock_quantity),0) into v_sum
      from product_variants where parent_product_id = v_pid;

    if p_sold_delta > 0 then
      update inventory set stock_quantity = v_sum::int, sold_quantity = v_sold_after, updated_at = now()
       where id = v_inv_id;
    else
      update inventory set stock_quantity = v_sum::int, updated_at = now()
       where id = v_inv_id;
    end if;
    get diagnostics v_rows = row_count;
    if v_rows <> 1 then raise exception 'inv4b_rowcount'; end if;
  exception when others then
    return jsonb_build_object('status','error','reason','apply_failed');
  end;

  return jsonb_build_object(
    'status','applied','op','adjust_variant_movement',
    'variantId', p_variant_id, 'productId', v_pid,
    'before', v_before, 'after', v_after,
    'parentBefore', v_parentbefore, 'parentStock', v_sum,
    'soldBefore', v_sold_before, 'soldAfter', v_sold_after
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants — server / service-role only (identical policy to the INV.3C/4A RPCs).
-- ---------------------------------------------------------------------------
revoke all on function public.inv_adjust_variant_movement(uuid, integer, integer) from public;
revoke all on function public.inv_adjust_variant_movement(uuid, integer, integer) from anon;
revoke all on function public.inv_adjust_variant_movement(uuid, integer, integer) from authenticated;
grant execute on function public.inv_adjust_variant_movement(uuid, integer, integer) to service_role;
