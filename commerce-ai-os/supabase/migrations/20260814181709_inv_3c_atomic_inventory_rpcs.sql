-- ============================================================================
-- INV.3C — Atomic Inventory RPC foundation.
--
-- Three SECURITY DEFINER functions that mutate numeric stock ATOMICALLY (one
-- transaction each), with fail-closed validation and deterministic row locking
-- modeled on process_talabat_order_deduction (PASS-1 verify → PASS-2 apply).
--
--   * inv_adjust_variant(p_variant_id, p_delta)         — apply a ± delta to one
--     variant, roll the parent inventory up to Σ variants.
--   * inv_set_variant_absolute(p_variant_id, p_quantity) — set one variant to an
--     absolute non-negative integer, roll the parent up.
--   * inv_place_shelf(p_scope, p_target_id, p_location, p_quantity) — authoritative
--     shelf placement. product scope: inventory.stock_quantity = Σ shelf_stock.
--     variant scope: product_variants.stock_quantity = Σ variant_shelf_stock, then
--     parent inventory = Σ variants.
--
-- NOT wired to any runtime writer yet (INV.3C is the foundation only). This
-- migration is NOT applied to production in INV.3C.
--
-- INVARIANTS / GUARANTEES:
--   * NO partial writes — PASS-1 does all validation + locking with no mutation;
--     PASS-2 applies inside a subtransaction and every UPDATE checks
--     GET DIAGNOSTICS ROW_COUNT = 1, so any anomaly rolls the whole apply back.
--   * FAIL-CLOSED — a NULL / negative / malformed current value (variant stock,
--     shelf quantity, or a rollup sibling) returns {status:error} and mutates
--     nothing; it is NEVER coalesced to 0.
--   * NO NEGATIVE STOCK — a resulting quantity below zero is rejected.
--   * DETERMINISTIC LOCKING — sibling variants are locked FOR UPDATE in a fixed
--     (sku, id) order BEFORE the parent inventory row (identical to the Talabat
--     RPC), so concurrent calls on the same parent serialize instead of deadlock
--     and cannot lost-update. No advisory lock is used: unlike the Talabat order
--     path there is no external dedup-key identity to serialize on here — the row
--     locks themselves are the whole concurrency contract.
--   * NEVER writes products.stock_quantity (stale mirror), and NEVER writes or
--     reads products.stock_status / product_variants.stock_status (availability is
--     a separate engine). NO stock task / ledger row is opened inside SQL — the
--     future runtime caller owns transitions + audit; each RPC returns before/
--     after + derived totals for that caller.
--   * NO sold_quantity change — these are adjustments/placements, not sales.
--
-- SHELF CONTRACT DECISION (documented, INV.3C scope):
--   inv_adjust_variant / inv_set_variant_absolute change a variant's stock
--   directly. If that variant HAS variant_shelf_stock rows, the shelf overlay
--   (Σ shelves must equal the variant stock) cannot be reconciled by a bare
--   stock change without inventing slot-placement behavior — so the operation is
--   REJECTED fail-closed with reason 'variant_has_shelf_rows'. Shelf-tracked
--   variants must be changed through inv_place_shelf (the authoritative shelf
--   path). Symmetrically, a variant rollup that would desync a product-level
--   shelf on the parent is rejected with 'parent_has_shelf_rows' (variant
--   products are not expected to carry product-level shelf_stock).
--
-- Idempotent (create or replace + guarded grants). Column types verified against
-- the live schema: product_variants.id / parent_product_id, inventory.id /
-- product_id, shelf_stock.inventory_id, variant_shelf_stock.variant_id are uuid;
-- all quantities are integer.
-- ============================================================================

-- Shared int4 ceiling used by every range check below.
--   2147483647 = max int4.

-- ---------------------------------------------------------------------------
-- inv_adjust_variant
-- ---------------------------------------------------------------------------
create or replace function public.inv_adjust_variant(
  p_variant_id uuid,
  p_delta      integer
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pid       uuid;
  v_before    integer;
  v_after_big bigint;
  v_after     integer;
  v_sibsum    bigint;
  v_parent_big bigint;
  v_inv_id    uuid;
  v_cnt       integer;
  v_sum       bigint;
  v_rows      integer;
begin
  -- ---- arg validation --------------------------------------------------------
  if p_variant_id is null then
    return jsonb_build_object('status','error','reason','missing_variant');
  end if;
  if p_delta is null then
    return jsonb_build_object('status','error','reason','invalid_delta');
  end if;

  -- ---- PASS 1: resolve + lock (deterministic) + verify (no writes) -----------
  select parent_product_id into v_pid from product_variants where id = p_variant_id;
  if not found then
    return jsonb_build_object('status','error','reason','missing_variant');
  end if;
  if v_pid is null then
    return jsonb_build_object('status','error','reason','missing_parent');
  end if;

  -- Lock ALL sibling variants of the parent in a fixed (sku, id) order BEFORE
  -- the parent inventory row — matches the Talabat lock sequence.
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

  -- Shelf-tracked variant → cannot reconcile a bare delta (see header decision).
  if exists (select 1 from variant_shelf_stock where variant_id = p_variant_id) then
    return jsonb_build_object('status','error','reason','variant_has_shelf_rows');
  end if;

  -- Resulting stock: bigint math to detect overflow before any int4 assignment.
  v_after_big := v_before::bigint + p_delta::bigint;
  if v_after_big < 0 then
    return jsonb_build_object('status','error','reason','insufficient_stock');
  end if;
  if v_after_big > 2147483647 then
    return jsonb_build_object('status','error','reason','overflow');
  end if;
  v_after := v_after_big::int;

  -- Exactly one parent inventory row; lock it.
  select count(*) into v_cnt from inventory where product_id = v_pid;
  if v_cnt <> 1 then
    return jsonb_build_object('status','error','reason','inventory_inconsistent');
  end if;
  select id into v_inv_id from inventory where product_id = v_pid for update;

  -- A product-level shelf on the parent would desync on a variant rollup.
  if exists (select 1 from shelf_stock where inventory_id = v_inv_id) then
    return jsonb_build_object('status','error','reason','parent_has_shelf_rows');
  end if;

  -- Parent rollup range check (siblings are locked, so the sum is stable).
  select coalesce(sum(stock_quantity),0) into v_sibsum
    from product_variants where parent_product_id = v_pid and id <> p_variant_id;
  v_parent_big := v_sibsum + v_after_big;
  if v_parent_big > 2147483647 then
    return jsonb_build_object('status','error','reason','overflow');
  end if;

  -- ---- PASS 2: apply everything or nothing (subtransaction) ------------------
  begin
    update product_variants set stock_quantity = v_after where id = p_variant_id;
    get diagnostics v_rows = row_count;
    if v_rows <> 1 then raise exception 'inv3c_rowcount'; end if;

    select coalesce(sum(stock_quantity),0) into v_sum
      from product_variants where parent_product_id = v_pid;
    update inventory set stock_quantity = v_sum::int, updated_at = now() where id = v_inv_id;
    get diagnostics v_rows = row_count;
    if v_rows <> 1 then raise exception 'inv3c_rowcount'; end if;
  exception when others then
    return jsonb_build_object('status','error','reason','apply_failed');
  end;

  return jsonb_build_object(
    'status','applied','op','adjust_variant',
    'variantId', p_variant_id, 'parentProductId', v_pid,
    'before', v_before, 'after', v_after, 'parentStock', v_sum
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- inv_set_variant_absolute
-- ---------------------------------------------------------------------------
create or replace function public.inv_set_variant_absolute(
  p_variant_id uuid,
  p_quantity   integer
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pid        uuid;
  v_before     integer;
  v_sibsum     bigint;
  v_parent_big bigint;
  v_inv_id     uuid;
  v_cnt        integer;
  v_sum        bigint;
  v_rows       integer;
begin
  if p_variant_id is null then
    return jsonb_build_object('status','error','reason','missing_variant');
  end if;
  -- Absolute must be a non-negative integer (p_quantity is int4; NULL/neg rejected).
  if p_quantity is null or p_quantity < 0 then
    return jsonb_build_object('status','error','reason','invalid_quantity');
  end if;

  select parent_product_id into v_pid from product_variants where id = p_variant_id;
  if not found then
    return jsonb_build_object('status','error','reason','missing_variant');
  end if;
  if v_pid is null then
    return jsonb_build_object('status','error','reason','missing_parent');
  end if;

  perform 1 from product_variants where parent_product_id = v_pid order by sku, id for update;

  if exists (select 1 from product_variants
               where parent_product_id = v_pid and (stock_quantity is null or stock_quantity < 0)) then
    return jsonb_build_object('status','error','reason','inventory_inconsistent');
  end if;

  select stock_quantity into v_before from product_variants where id = p_variant_id;
  if v_before is null or v_before < 0 then
    return jsonb_build_object('status','error','reason','inventory_inconsistent');
  end if;

  if exists (select 1 from variant_shelf_stock where variant_id = p_variant_id) then
    return jsonb_build_object('status','error','reason','variant_has_shelf_rows');
  end if;

  select count(*) into v_cnt from inventory where product_id = v_pid;
  if v_cnt <> 1 then
    return jsonb_build_object('status','error','reason','inventory_inconsistent');
  end if;
  select id into v_inv_id from inventory where product_id = v_pid for update;

  if exists (select 1 from shelf_stock where inventory_id = v_inv_id) then
    return jsonb_build_object('status','error','reason','parent_has_shelf_rows');
  end if;

  select coalesce(sum(stock_quantity),0) into v_sibsum
    from product_variants where parent_product_id = v_pid and id <> p_variant_id;
  v_parent_big := v_sibsum + p_quantity::bigint;
  if v_parent_big > 2147483647 then
    return jsonb_build_object('status','error','reason','overflow');
  end if;

  begin
    update product_variants set stock_quantity = p_quantity where id = p_variant_id;
    get diagnostics v_rows = row_count;
    if v_rows <> 1 then raise exception 'inv3c_rowcount'; end if;

    select coalesce(sum(stock_quantity),0) into v_sum
      from product_variants where parent_product_id = v_pid;
    update inventory set stock_quantity = v_sum::int, updated_at = now() where id = v_inv_id;
    get diagnostics v_rows = row_count;
    if v_rows <> 1 then raise exception 'inv3c_rowcount'; end if;
  exception when others then
    return jsonb_build_object('status','error','reason','apply_failed');
  end;

  return jsonb_build_object(
    'status','applied','op','set_variant_absolute',
    'variantId', p_variant_id, 'parentProductId', v_pid,
    'before', v_before, 'after', p_quantity, 'parentStock', v_sum
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- inv_place_shelf — authoritative shelf placement/count.
--   p_scope = 'product'  → p_target_id is an inventory.id (product with NO variants)
--   p_scope = 'variant'  → p_target_id is a product_variants.id
-- p_quantity 0 removes the placement at that slot.
-- ---------------------------------------------------------------------------
create or replace function public.inv_place_shelf(
  p_scope     text,
  p_target_id uuid,
  p_location  text,
  p_quantity  integer
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_loc      text;
  v_pid      uuid;
  v_inv_id   uuid;
  v_cnt      integer;
  v_other    bigint;
  v_sum_big  bigint;
  v_vother   bigint;
  v_vstock_big bigint;
  v_sibsum   bigint;
  v_parent_big bigint;
  v_shelfsum bigint;
  v_vsum     bigint;
  v_psum     bigint;
  v_rows     integer;
begin
  -- ---- arg validation --------------------------------------------------------
  if p_scope is null or p_scope not in ('product','variant') then
    return jsonb_build_object('status','error','reason','invalid_scope');
  end if;
  if p_target_id is null then
    return jsonb_build_object('status','error','reason','missing_target');
  end if;
  if p_quantity is null or p_quantity < 0 then
    return jsonb_build_object('status','error','reason','invalid_quantity');
  end if;
  v_loc := upper(btrim(coalesce(p_location,'')));
  if v_loc = '' then
    return jsonb_build_object('status','error','reason','invalid_location');
  end if;

  if p_scope = 'product' then
    -- ---- PRODUCT shelf: inventory.stock_quantity = Σ shelf_stock -------------
    select count(*) into v_cnt from inventory where id = p_target_id;
    if v_cnt <> 1 then
      return jsonb_build_object('status','error','reason','missing_inventory');
    end if;
    select product_id into v_pid from inventory where id = p_target_id for update;

    -- Product-level shelves are only authoritative for products with NO variants
    -- (variant products track shelves per option via variant_shelf_stock).
    if exists (select 1 from product_variants where parent_product_id = v_pid) then
      return jsonb_build_object('status','error','reason','product_has_variants');
    end if;

    perform 1 from shelf_stock where inventory_id = p_target_id for update;
    if exists (select 1 from shelf_stock where inventory_id = p_target_id and (quantity is null or quantity < 0)) then
      return jsonb_build_object('status','error','reason','inventory_inconsistent');
    end if;

    -- Range check the resulting master total (other slots + this placement).
    select coalesce(sum(quantity),0) into v_other
      from shelf_stock where inventory_id = p_target_id and location <> v_loc;
    v_sum_big := v_other + (case when p_quantity = 0 then 0 else p_quantity end)::bigint;
    if v_sum_big > 2147483647 then
      return jsonb_build_object('status','error','reason','overflow');
    end if;

    begin
      if p_quantity = 0 then
        delete from shelf_stock where inventory_id = p_target_id and location = v_loc;
      else
        insert into shelf_stock (inventory_id, location, quantity, updated_at)
        values (p_target_id, v_loc, p_quantity, now())
        on conflict (inventory_id, location) do update set quantity = excluded.quantity, updated_at = now();
      end if;
      select coalesce(sum(quantity),0) into v_shelfsum from shelf_stock where inventory_id = p_target_id;
      update inventory set stock_quantity = v_shelfsum::int, updated_at = now() where id = p_target_id;
      get diagnostics v_rows = row_count;
      if v_rows <> 1 then raise exception 'inv3c_rowcount'; end if;
    exception when others then
      return jsonb_build_object('status','error','reason','apply_failed');
    end;

    return jsonb_build_object(
      'status','applied','op','place_shelf','scope','product',
      'inventoryId', p_target_id, 'productId', v_pid,
      'location', v_loc, 'quantity', p_quantity,
      'shelfSum', v_shelfsum, 'stock', v_shelfsum
    );
  else
    -- ---- VARIANT shelf: variant.stock = Σ variant shelves; parent = Σ variants
    select parent_product_id into v_pid from product_variants where id = p_target_id;
    if not found then
      return jsonb_build_object('status','error','reason','missing_variant');
    end if;
    if v_pid is null then
      return jsonb_build_object('status','error','reason','missing_parent');
    end if;

    -- Lock siblings deterministically, then this variant's shelves, then parent.
    perform 1 from product_variants where parent_product_id = v_pid order by sku, id for update;

    -- Every OTHER sibling must be well-formed (this variant is recomputed below).
    if exists (select 1 from product_variants
                 where parent_product_id = v_pid and id <> p_target_id and (stock_quantity is null or stock_quantity < 0)) then
      return jsonb_build_object('status','error','reason','inventory_inconsistent');
    end if;

    perform 1 from variant_shelf_stock where variant_id = p_target_id for update;
    if exists (select 1 from variant_shelf_stock where variant_id = p_target_id and (quantity is null or quantity < 0)) then
      return jsonb_build_object('status','error','reason','inventory_inconsistent');
    end if;

    select count(*) into v_cnt from inventory where product_id = v_pid;
    if v_cnt <> 1 then
      return jsonb_build_object('status','error','reason','inventory_inconsistent');
    end if;
    select id into v_inv_id from inventory where product_id = v_pid for update;

    -- A variant product must not carry a product-level shelf (ambiguous overlay).
    if exists (select 1 from shelf_stock where inventory_id = v_inv_id) then
      return jsonb_build_object('status','error','reason','parent_has_shelf_rows');
    end if;

    -- Range checks: new variant stock, then new parent rollup.
    select coalesce(sum(quantity),0) into v_vother
      from variant_shelf_stock where variant_id = p_target_id and location <> v_loc;
    v_vstock_big := v_vother + (case when p_quantity = 0 then 0 else p_quantity end)::bigint;
    if v_vstock_big > 2147483647 then
      return jsonb_build_object('status','error','reason','overflow');
    end if;
    select coalesce(sum(stock_quantity),0) into v_sibsum
      from product_variants where parent_product_id = v_pid and id <> p_target_id;
    v_parent_big := v_sibsum + v_vstock_big;
    if v_parent_big > 2147483647 then
      return jsonb_build_object('status','error','reason','overflow');
    end if;

    begin
      if p_quantity = 0 then
        delete from variant_shelf_stock where variant_id = p_target_id and location = v_loc;
      else
        insert into variant_shelf_stock (variant_id, location, quantity, updated_at)
        values (p_target_id, v_loc, p_quantity, now())
        on conflict (variant_id, location) do update set quantity = excluded.quantity, updated_at = now();
      end if;

      select coalesce(sum(quantity),0) into v_vsum from variant_shelf_stock where variant_id = p_target_id;
      update product_variants set stock_quantity = v_vsum::int where id = p_target_id;
      get diagnostics v_rows = row_count;
      if v_rows <> 1 then raise exception 'inv3c_rowcount'; end if;

      select coalesce(sum(stock_quantity),0) into v_psum
        from product_variants where parent_product_id = v_pid;
      update inventory set stock_quantity = v_psum::int, updated_at = now() where id = v_inv_id;
      get diagnostics v_rows = row_count;
      if v_rows <> 1 then raise exception 'inv3c_rowcount'; end if;
    exception when others then
      return jsonb_build_object('status','error','reason','apply_failed');
    end;

    return jsonb_build_object(
      'status','applied','op','place_shelf','scope','variant',
      'variantId', p_target_id, 'parentProductId', v_pid, 'inventoryId', v_inv_id,
      'location', v_loc, 'quantity', p_quantity,
      'variantStock', v_vsum, 'parentStock', v_psum
    );
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants — server / service-role only. The browser (anon, authenticated) can
-- NEVER call these directly (identical policy to the Talabat/Shopify RPCs).
-- ---------------------------------------------------------------------------
revoke all on function public.inv_adjust_variant(uuid, integer) from public;
revoke all on function public.inv_adjust_variant(uuid, integer) from anon;
revoke all on function public.inv_adjust_variant(uuid, integer) from authenticated;
grant execute on function public.inv_adjust_variant(uuid, integer) to service_role;

revoke all on function public.inv_set_variant_absolute(uuid, integer) from public;
revoke all on function public.inv_set_variant_absolute(uuid, integer) from anon;
revoke all on function public.inv_set_variant_absolute(uuid, integer) from authenticated;
grant execute on function public.inv_set_variant_absolute(uuid, integer) to service_role;

revoke all on function public.inv_place_shelf(text, uuid, text, integer) from public;
revoke all on function public.inv_place_shelf(text, uuid, text, integer) from anon;
revoke all on function public.inv_place_shelf(text, uuid, text, integer) from authenticated;
grant execute on function public.inv_place_shelf(text, uuid, text, integer) to service_role;
