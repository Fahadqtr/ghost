-- ============================================================================
-- INV.4A — atomic absolute-set for a SIMPLE product's inventory row.
--
-- inv_set_absolute_product(p_inventory_id uuid, p_quantity integer) → jsonb
--
-- Sets inventory.stock_quantity to an absolute non-negative integer for a
-- SIMPLE product (no variants, no shelf rows). It is the product-grain primitive
-- behind engine.setAbsolute, used by the migrated manual / bulk / CSV / product
-- stocktake writers (INV.4A). Modeled on the INV.3C RPCs (PASS-1 verify →
-- PASS-2 apply); one transaction.
--
-- GUARANTEES:
--   * PASS-1 does all validation + locking with NO write; PASS-2 applies inside a
--     subtransaction and the single UPDATE checks GET DIAGNOSTICS ROW_COUNT = 1,
--     so any anomaly rolls the apply back → {status:error, reason:apply_failed}.
--   * FAIL-CLOSED: a NULL / negative current stock returns {status:error} and
--     mutates nothing (never coalesced to 0). p_quantity NULL / negative rejected.
--     (p_quantity is int4, so a fractional value cannot reach the contract.)
--   * SCOPE GUARD (correctness, not convenience): a product WITH variants is
--     rejected 'product_has_variants' (the parent pool is Σ variants — never set
--     directly; variant writers move in INV.4B). A product WITH shelf_stock rows
--     is rejected 'product_has_shelf_rows' (master must equal Σ shelves — handled
--     by the shelf RPC in INV.4C). NO shelf row is deleted, NO quantity is
--     auto-distributed, NO shelf reconciliation is invented here.
--   * Writes ONLY inventory.stock_quantity + updated_at. NEVER products.stock_quantity
--     (stale mirror), NEVER stock_status / availability, NEVER sold_quantity. NO
--     stock task and NO audit row inside SQL — the caller owns transitions + audit
--     (the RPC returns before/after + productId).
--
-- Idempotent (create or replace + guarded grants). 2147483647 = max int4.
-- ============================================================================

create or replace function public.inv_set_absolute_product(
  p_inventory_id uuid,
  p_quantity     integer
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pid     uuid;
  v_before  integer;
  v_rows    integer;
begin
  -- ---- arg validation --------------------------------------------------------
  if p_inventory_id is null then
    return jsonb_build_object('status','error','reason','missing_inventory');
  end if;
  if p_quantity is null or p_quantity < 0 then
    return jsonb_build_object('status','error','reason','invalid_quantity');
  end if;
  if p_quantity > 2147483647 then
    return jsonb_build_object('status','error','reason','overflow');
  end if;

  -- ---- PASS 1: lock + resolve + verify (no writes) ---------------------------
  select product_id, stock_quantity into v_pid, v_before
    from inventory where id = p_inventory_id for update;
  if not found then
    return jsonb_build_object('status','error','reason','missing_inventory');
  end if;
  if v_pid is null then
    return jsonb_build_object('status','error','reason','inventory_inconsistent');
  end if;
  -- Current stock must be a well-formed non-negative integer (fail-closed).
  if v_before is null or v_before < 0 then
    return jsonb_build_object('status','error','reason','inventory_inconsistent');
  end if;

  -- A product with variants: the parent pool is Σ variants — never set directly.
  if exists (select 1 from product_variants where parent_product_id = v_pid) then
    return jsonb_build_object('status','error','reason','product_has_variants');
  end if;

  -- A shelf-tracked product: master must equal Σ shelves — use the shelf RPC.
  if exists (select 1 from shelf_stock where inventory_id = p_inventory_id) then
    return jsonb_build_object('status','error','reason','product_has_shelf_rows');
  end if;

  -- ---- PASS 2: apply (subtransaction) ----------------------------------------
  begin
    update inventory set stock_quantity = p_quantity, updated_at = now()
     where id = p_inventory_id;
    get diagnostics v_rows = row_count;
    if v_rows <> 1 then raise exception 'inv4a_rowcount'; end if;
  exception when others then
    return jsonb_build_object('status','error','reason','apply_failed');
  end;

  return jsonb_build_object(
    'status','applied','op','set_absolute_product',
    'inventoryId', p_inventory_id, 'productId', v_pid,
    'before', v_before, 'after', p_quantity
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants — server / service-role only (identical policy to the INV.3C RPCs).
-- ---------------------------------------------------------------------------
revoke all on function public.inv_set_absolute_product(uuid, integer) from public;
revoke all on function public.inv_set_absolute_product(uuid, integer) from anon;
revoke all on function public.inv_set_absolute_product(uuid, integer) from authenticated;
grant execute on function public.inv_set_absolute_product(uuid, integer) to service_role;
