-- ============================================================================
-- INV.4C — atomic shelf / distribution operations.
--
-- The shelf tables are a DISTRIBUTION OVERLAY on the numeric stock:
--   PRODUCT shelf-tracked:  inventory.stock_quantity        = Σ shelf_stock.quantity
--   VARIANT shelf-tracked:  product_variants.stock_quantity = Σ variant_shelf_stock.quantity
--                           parent inventory.stock_quantity = Σ variants
--   inventory.location (simple product) = PRIMARY shelf pointer = the slot with the
--   largest placement, ties broken by location ASC; null when there is no placement.
--
-- Four SECURITY DEFINER functions, one transaction each, modeled on the INV.3C/4A/4B
-- RPCs (PASS-1 verify + deterministic FOR UPDATE locking → PASS-2 apply inside a
-- subtransaction with GET DIAGNOSTICS rowcount checks):
--
--   * inv_place_shelf(scope, target, location, quantity)   — UPGRADED (create or
--     replace, same signature): set/remove ONE slot; re-derive stock from Σ shelves;
--     product now also syncs inventory.location = primary. Adds authoritative BEFORE
--     fields + primaryLocation to the result. This is a DISTRIBUTION EDIT (type A):
--     removing the last placement re-derives stock to 0 (NOT an untrack).
--   * inv_replace_shelf_distribution(scope, target, rows jsonb) — replace the WHOLE
--     distribution atomically. Non-empty rows → stock = Σ rows, location = primary.
--     EMPTY rows array = explicit UNTRACK (type B): drop all shelf rows, location=null,
--     and PRESERVE the current authoritative stock (never zero it).
--   * inv_assign_full_shelf(scope, target, location, quantity default null) — place the
--     whole current stock (quantity NULL) or a forced quantity into ONE slot; empty
--     location = explicit UNTRACK (preserve stock). quantity 0 → no shelf row +
--     location null, stock forced to 0.
--   * inv_move_shelf(scope, target, from, to) — move a whole placement from→to (merge
--     if `to` exists). Total stock (product) / variant + parent stock (variant) is
--     invariant; primary recomputed. Fail-closed if the source placement is absent.
--
-- TWO KINDS OF REMOVAL (documented contract, do not conflate "0 stock" with "stop
-- tracking shelves"):
--   A) count/remove a placement within an authoritative distribution → re-derive
--      stock from Σ shelves; all placements gone ⇒ stock may become 0.
--   B) explicit UNTRACK / clear (empty rows, or empty location) → drop the overlay,
--      location=null, PRESERVE the current authoritative stock.
--
-- GUARANTEES: fail-closed on NULL/negative/malformed quantities (variant stock, shelf
-- quantity, rollup sibling) — never coalesced to 0; no negative results; int4 overflow
-- guarded; deterministic sibling+parent locking; product-with-variants and a variant
-- product carrying a product-level shelf are rejected. NEVER writes products.stock_quantity
-- (stale mirror), stock_status / availability, or sold_quantity. NO stock task and NO
-- audit row inside SQL — the runtime caller owns transitions + audit; each RPC returns
-- before/after + derived totals. service_role-only grants.
--
-- Idempotent (create or replace + guarded grants). 2147483647 = max int4.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- inv_place_shelf — UPGRADED (same signature). Set/remove ONE slot (type A edit).
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
  v_loc        text;
  v_pid        uuid;
  v_inv_id     uuid;
  v_cnt        integer;
  v_stockbefore integer;
  v_other      bigint;
  v_sum_big    bigint;
  v_vother     bigint;
  v_vstock_big bigint;
  v_sibsum     bigint;
  v_parent_big bigint;
  v_shelfsum   bigint;
  v_vsum       bigint;
  v_psum       bigint;
  v_vbefore    integer;
  v_parentbefore bigint;
  v_primary    text;
  v_rows       integer;
begin
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
    select count(*) into v_cnt from inventory where id = p_target_id;
    if v_cnt <> 1 then
      return jsonb_build_object('status','error','reason','missing_inventory');
    end if;
    select product_id, stock_quantity into v_pid, v_stockbefore from inventory where id = p_target_id for update;
    if exists (select 1 from product_variants where parent_product_id = v_pid) then
      return jsonb_build_object('status','error','reason','product_has_variants');
    end if;

    perform 1 from shelf_stock where inventory_id = p_target_id for update;
    if exists (select 1 from shelf_stock where inventory_id = p_target_id and (quantity is null or quantity < 0)) then
      return jsonb_build_object('status','error','reason','inventory_inconsistent');
    end if;

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
      select location into v_primary from shelf_stock
        where inventory_id = p_target_id and quantity > 0
        order by quantity desc, location asc limit 1;
      update inventory set stock_quantity = v_shelfsum::int, location = v_primary, updated_at = now()
       where id = p_target_id;
      get diagnostics v_rows = row_count;
      if v_rows <> 1 then raise exception 'inv4c_rowcount'; end if;
    exception when others then
      return jsonb_build_object('status','error','reason','apply_failed');
    end;

    return jsonb_build_object(
      'status','applied','op','place_shelf','scope','product',
      'inventoryId', p_target_id, 'productId', v_pid,
      'location', v_loc, 'quantity', p_quantity,
      'stockBefore', v_stockbefore, 'stock', v_shelfsum, 'shelfSum', v_shelfsum,
      'primaryLocation', v_primary
    );
  else
    select parent_product_id into v_pid from product_variants where id = p_target_id;
    if not found then
      return jsonb_build_object('status','error','reason','missing_variant');
    end if;
    if v_pid is null then
      return jsonb_build_object('status','error','reason','missing_parent');
    end if;

    perform 1 from product_variants where parent_product_id = v_pid order by sku, id for update;
    if exists (select 1 from product_variants
                 where parent_product_id = v_pid and id <> p_target_id and (stock_quantity is null or stock_quantity < 0)) then
      return jsonb_build_object('status','error','reason','inventory_inconsistent');
    end if;
    select stock_quantity into v_vbefore from product_variants where id = p_target_id;
    if v_vbefore is null or v_vbefore < 0 then
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
    if exists (select 1 from shelf_stock where inventory_id = v_inv_id) then
      return jsonb_build_object('status','error','reason','parent_has_shelf_rows');
    end if;

    select coalesce(sum(stock_quantity),0) into v_parentbefore
      from product_variants where parent_product_id = v_pid;

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
      if v_rows <> 1 then raise exception 'inv4c_rowcount'; end if;
      select coalesce(sum(stock_quantity),0) into v_psum
        from product_variants where parent_product_id = v_pid;
      update inventory set stock_quantity = v_psum::int, updated_at = now() where id = v_inv_id;
      get diagnostics v_rows = row_count;
      if v_rows <> 1 then raise exception 'inv4c_rowcount'; end if;
    exception when others then
      return jsonb_build_object('status','error','reason','apply_failed');
    end;

    return jsonb_build_object(
      'status','applied','op','place_shelf','scope','variant',
      'variantId', p_target_id, 'parentProductId', v_pid, 'inventoryId', v_inv_id,
      'location', v_loc, 'quantity', p_quantity,
      'variantBefore', v_vbefore, 'variantStock', v_vsum,
      'parentBefore', v_parentbefore, 'parentStock', v_psum
    );
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- inv_replace_shelf_distribution — replace the WHOLE overlay atomically.
--   p_rows: jsonb array of {"location": text, "quantity": number}.
--   [] (empty array) = explicit UNTRACK: drop overlay, preserve stock, location=null.
-- ---------------------------------------------------------------------------
create or replace function public.inv_replace_shelf_distribution(
  p_scope     text,
  p_target_id uuid,
  p_rows      jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_el         jsonb;
  v_loc        text;
  v_qnum       numeric;
  v_q          integer;
  v_merged     jsonb := '{}'::jsonb;
  v_sum_big    bigint := 0;
  v_nonempty   boolean;
  v_pid        uuid;
  v_inv_id     uuid;
  v_cnt        integer;
  v_stockbefore integer;
  v_vbefore    integer;
  v_parentbefore bigint;
  v_primary    text;
  v_newstock   integer;
  v_vsum       bigint;
  v_psum       bigint;
  v_sibsum     bigint;
  v_rows       integer;
begin
  if p_scope is null or p_scope not in ('product','variant') then
    return jsonb_build_object('status','error','reason','invalid_scope');
  end if;
  if p_target_id is null then
    return jsonb_build_object('status','error','reason','missing_target');
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    return jsonb_build_object('status','error','reason','invalid_rows');
  end if;

  -- Normalize + validate + MERGE duplicate locations (sum). Fail-closed.
  for v_el in select * from jsonb_array_elements(p_rows) loop
    if jsonb_typeof(v_el) <> 'object' then
      return jsonb_build_object('status','error','reason','invalid_rows');
    end if;
    v_loc := upper(btrim(coalesce(v_el->>'location','')));
    if v_loc = '' then
      return jsonb_build_object('status','error','reason','invalid_location');
    end if;
    if jsonb_typeof(v_el->'quantity') <> 'number' then
      return jsonb_build_object('status','error','reason','invalid_quantity');
    end if;
    v_qnum := (v_el->>'quantity')::numeric;
    if v_qnum < 0 or v_qnum <> trunc(v_qnum) then
      return jsonb_build_object('status','error','reason','invalid_quantity');
    end if;
    if v_qnum > 2147483647 then
      return jsonb_build_object('status','error','reason','overflow');
    end if;
    v_q := v_qnum::int;
    v_merged := jsonb_set(
      v_merged, array[v_loc],
      to_jsonb(coalesce((v_merged->>v_loc)::bigint, 0) + v_q), true);
  end loop;

  select coalesce(sum((value)::text::bigint),0) into v_sum_big from jsonb_each(v_merged);
  if v_sum_big > 2147483647 then
    return jsonb_build_object('status','error','reason','overflow');
  end if;
  v_nonempty := (v_merged <> '{}'::jsonb);

  if p_scope = 'product' then
    select count(*) into v_cnt from inventory where id = p_target_id;
    if v_cnt <> 1 then
      return jsonb_build_object('status','error','reason','missing_inventory');
    end if;
    select product_id, stock_quantity into v_pid, v_stockbefore from inventory where id = p_target_id for update;
    if v_stockbefore is null or v_stockbefore < 0 then
      return jsonb_build_object('status','error','reason','inventory_inconsistent');
    end if;
    if exists (select 1 from product_variants where parent_product_id = v_pid) then
      return jsonb_build_object('status','error','reason','product_has_variants');
    end if;
    perform 1 from shelf_stock where inventory_id = p_target_id for update;

    begin
      delete from shelf_stock where inventory_id = p_target_id;
      if v_nonempty then
        insert into shelf_stock (inventory_id, location, quantity, updated_at)
        select p_target_id, key, (value)::text::int, now()
          from jsonb_each(v_merged) where (value)::text::bigint > 0;
        select location into v_primary from shelf_stock
          where inventory_id = p_target_id and quantity > 0
          order by quantity desc, location asc limit 1;
        v_newstock := v_sum_big::int;
      else
        -- explicit UNTRACK: preserve stock, clear pointer.
        v_primary := null;
        v_newstock := v_stockbefore;
      end if;
      update inventory set stock_quantity = v_newstock, location = v_primary, updated_at = now()
       where id = p_target_id;
      get diagnostics v_rows = row_count;
      if v_rows <> 1 then raise exception 'inv4c_rowcount'; end if;
    exception when others then
      return jsonb_build_object('status','error','reason','apply_failed');
    end;

    return jsonb_build_object(
      'status','applied','op','replace_distribution','scope','product',
      'inventoryId', p_target_id, 'productId', v_pid,
      'stockBefore', v_stockbefore, 'stock', v_newstock,
      'shelfSum', v_sum_big, 'primaryLocation', v_primary, 'untracked', not v_nonempty
    );
  else
    select parent_product_id into v_pid from product_variants where id = p_target_id;
    if not found then
      return jsonb_build_object('status','error','reason','missing_variant');
    end if;
    if v_pid is null then
      return jsonb_build_object('status','error','reason','missing_parent');
    end if;
    perform 1 from product_variants where parent_product_id = v_pid order by sku, id for update;
    if exists (select 1 from product_variants
                 where parent_product_id = v_pid and id <> p_target_id and (stock_quantity is null or stock_quantity < 0)) then
      return jsonb_build_object('status','error','reason','inventory_inconsistent');
    end if;
    select stock_quantity into v_vbefore from product_variants where id = p_target_id;
    if v_vbefore is null or v_vbefore < 0 then
      return jsonb_build_object('status','error','reason','inventory_inconsistent');
    end if;
    perform 1 from variant_shelf_stock where variant_id = p_target_id for update;
    select count(*) into v_cnt from inventory where product_id = v_pid;
    if v_cnt <> 1 then
      return jsonb_build_object('status','error','reason','inventory_inconsistent');
    end if;
    select id into v_inv_id from inventory where product_id = v_pid for update;
    if exists (select 1 from shelf_stock where inventory_id = v_inv_id) then
      return jsonb_build_object('status','error','reason','parent_has_shelf_rows');
    end if;
    select coalesce(sum(stock_quantity),0) into v_parentbefore
      from product_variants where parent_product_id = v_pid;
    -- parent rollup range check (siblings + this variant's post value)
    select coalesce(sum(stock_quantity),0) into v_sibsum
      from product_variants where parent_product_id = v_pid and id <> p_target_id;
    if v_sibsum + (case when v_nonempty then v_sum_big else v_vbefore end) > 2147483647 then
      return jsonb_build_object('status','error','reason','overflow');
    end if;

    begin
      delete from variant_shelf_stock where variant_id = p_target_id;
      if v_nonempty then
        insert into variant_shelf_stock (variant_id, location, quantity, updated_at)
        select p_target_id, key, (value)::text::int, now()
          from jsonb_each(v_merged) where (value)::text::bigint > 0;
        update product_variants set stock_quantity = v_sum_big::int where id = p_target_id;
        get diagnostics v_rows = row_count;
        if v_rows <> 1 then raise exception 'inv4c_rowcount'; end if;
      end if;
      -- untrack: preserve variant stock (no update).
      select coalesce(sum(stock_quantity),0) into v_psum
        from product_variants where parent_product_id = v_pid;
      update inventory set stock_quantity = v_psum::int, updated_at = now() where id = v_inv_id;
      get diagnostics v_rows = row_count;
      if v_rows <> 1 then raise exception 'inv4c_rowcount'; end if;
    exception when others then
      return jsonb_build_object('status','error','reason','apply_failed');
    end;

    select stock_quantity into v_vsum from product_variants where id = p_target_id;
    return jsonb_build_object(
      'status','applied','op','replace_distribution','scope','variant',
      'variantId', p_target_id, 'parentProductId', v_pid, 'inventoryId', v_inv_id,
      'variantBefore', v_vbefore, 'variantStock', v_vsum,
      'parentBefore', v_parentbefore, 'parentStock', v_psum, 'untracked', not v_nonempty
    );
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- inv_assign_full_shelf — place the whole current stock (or a forced quantity)
-- into ONE slot; empty location = explicit UNTRACK (preserve stock).
-- ---------------------------------------------------------------------------
create or replace function public.inv_assign_full_shelf(
  p_scope     text,
  p_target_id uuid,
  p_location  text,
  p_quantity  integer default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_loc         text;
  v_untrack     boolean;
  v_pid         uuid;
  v_inv_id      uuid;
  v_cnt         integer;
  v_stockbefore integer;
  v_vbefore     integer;
  v_parentbefore bigint;
  v_target      integer;
  v_newstock    integer;
  v_primary     text;
  v_psum        bigint;
  v_sibsum      bigint;
  v_rows        integer;
begin
  if p_scope is null or p_scope not in ('product','variant') then
    return jsonb_build_object('status','error','reason','invalid_scope');
  end if;
  if p_target_id is null then
    return jsonb_build_object('status','error','reason','missing_target');
  end if;
  if p_quantity is not null and p_quantity < 0 then
    return jsonb_build_object('status','error','reason','invalid_quantity');
  end if;
  if p_quantity is not null and p_quantity > 2147483647 then
    return jsonb_build_object('status','error','reason','overflow');
  end if;
  v_loc := upper(btrim(coalesce(p_location,'')));
  v_untrack := (v_loc = '');

  if p_scope = 'product' then
    select count(*) into v_cnt from inventory where id = p_target_id;
    if v_cnt <> 1 then
      return jsonb_build_object('status','error','reason','missing_inventory');
    end if;
    select product_id, stock_quantity into v_pid, v_stockbefore from inventory where id = p_target_id for update;
    if v_stockbefore is null or v_stockbefore < 0 then
      return jsonb_build_object('status','error','reason','inventory_inconsistent');
    end if;
    if exists (select 1 from product_variants where parent_product_id = v_pid) then
      return jsonb_build_object('status','error','reason','product_has_variants');
    end if;
    perform 1 from shelf_stock where inventory_id = p_target_id for update;

    v_target := coalesce(p_quantity, v_stockbefore);

    begin
      delete from shelf_stock where inventory_id = p_target_id;
      if (not v_untrack) and v_target > 0 then
        insert into shelf_stock (inventory_id, location, quantity, updated_at)
        values (p_target_id, v_loc, v_target, now());
        v_primary := v_loc;
        v_newstock := v_target;
      else
        v_primary := null;
        if v_untrack and p_quantity is null then
          v_newstock := v_stockbefore;   -- explicit untrack, preserve stock
        else
          v_newstock := v_target;        -- forced quantity (incl. 0), or 0 current
        end if;
      end if;
      update inventory set stock_quantity = v_newstock, location = v_primary, updated_at = now()
       where id = p_target_id;
      get diagnostics v_rows = row_count;
      if v_rows <> 1 then raise exception 'inv4c_rowcount'; end if;
    exception when others then
      return jsonb_build_object('status','error','reason','apply_failed');
    end;

    return jsonb_build_object(
      'status','applied','op','assign_full_shelf','scope','product',
      'inventoryId', p_target_id, 'productId', v_pid,
      'location', case when v_untrack then null else v_loc end,
      'stockBefore', v_stockbefore, 'stock', v_newstock,
      'primaryLocation', v_primary, 'untracked', v_untrack
    );
  else
    select parent_product_id into v_pid from product_variants where id = p_target_id;
    if not found then
      return jsonb_build_object('status','error','reason','missing_variant');
    end if;
    if v_pid is null then
      return jsonb_build_object('status','error','reason','missing_parent');
    end if;
    perform 1 from product_variants where parent_product_id = v_pid order by sku, id for update;
    if exists (select 1 from product_variants
                 where parent_product_id = v_pid and id <> p_target_id and (stock_quantity is null or stock_quantity < 0)) then
      return jsonb_build_object('status','error','reason','inventory_inconsistent');
    end if;
    select stock_quantity into v_vbefore from product_variants where id = p_target_id;
    if v_vbefore is null or v_vbefore < 0 then
      return jsonb_build_object('status','error','reason','inventory_inconsistent');
    end if;
    perform 1 from variant_shelf_stock where variant_id = p_target_id for update;
    select count(*) into v_cnt from inventory where product_id = v_pid;
    if v_cnt <> 1 then
      return jsonb_build_object('status','error','reason','inventory_inconsistent');
    end if;
    select id into v_inv_id from inventory where product_id = v_pid for update;
    if exists (select 1 from shelf_stock where inventory_id = v_inv_id) then
      return jsonb_build_object('status','error','reason','parent_has_shelf_rows');
    end if;
    select coalesce(sum(stock_quantity),0) into v_parentbefore
      from product_variants where parent_product_id = v_pid;

    v_target := coalesce(p_quantity, v_vbefore);
    select coalesce(sum(stock_quantity),0) into v_sibsum
      from product_variants where parent_product_id = v_pid and id <> p_target_id;
    if v_sibsum + (case when v_untrack and p_quantity is null then v_vbefore else v_target end) > 2147483647 then
      return jsonb_build_object('status','error','reason','overflow');
    end if;

    begin
      delete from variant_shelf_stock where variant_id = p_target_id;
      if (not v_untrack) and v_target > 0 then
        insert into variant_shelf_stock (variant_id, location, quantity, updated_at)
        values (p_target_id, v_loc, v_target, now());
        update product_variants set stock_quantity = v_target where id = p_target_id;
        get diagnostics v_rows = row_count;
        if v_rows <> 1 then raise exception 'inv4c_rowcount'; end if;
      elsif v_untrack and p_quantity is null then
        null; -- preserve variant stock
      else
        update product_variants set stock_quantity = v_target where id = p_target_id;
        get diagnostics v_rows = row_count;
        if v_rows <> 1 then raise exception 'inv4c_rowcount'; end if;
      end if;
      select coalesce(sum(stock_quantity),0) into v_psum
        from product_variants where parent_product_id = v_pid;
      update inventory set stock_quantity = v_psum::int, updated_at = now() where id = v_inv_id;
      get diagnostics v_rows = row_count;
      if v_rows <> 1 then raise exception 'inv4c_rowcount'; end if;
    exception when others then
      return jsonb_build_object('status','error','reason','apply_failed');
    end;

    select stock_quantity into v_newstock from product_variants where id = p_target_id;
    return jsonb_build_object(
      'status','applied','op','assign_full_shelf','scope','variant',
      'variantId', p_target_id, 'parentProductId', v_pid, 'inventoryId', v_inv_id,
      'location', case when v_untrack then null else v_loc end,
      'variantBefore', v_vbefore, 'variantStock', v_newstock,
      'parentBefore', v_parentbefore, 'parentStock', v_psum, 'untracked', v_untrack
    );
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- inv_move_shelf — move a whole placement from→to (merge if `to` exists).
-- Total stock is invariant; primary recomputed. Fail-closed if source absent.
-- ---------------------------------------------------------------------------
create or replace function public.inv_move_shelf(
  p_scope         text,
  p_target_id     uuid,
  p_from_location text,
  p_to_location   text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_from      text;
  v_to        text;
  v_pid       uuid;
  v_inv_id    uuid;
  v_cnt       integer;
  v_src       integer;
  v_dst       integer;
  v_moved     integer;
  v_merge_big bigint;
  v_primary   text;
  v_stock     bigint;
  v_pstock    bigint;
  v_rows      integer;
begin
  if p_scope is null or p_scope not in ('product','variant') then
    return jsonb_build_object('status','error','reason','invalid_scope');
  end if;
  if p_target_id is null then
    return jsonb_build_object('status','error','reason','missing_target');
  end if;
  v_from := upper(btrim(coalesce(p_from_location,'')));
  v_to   := upper(btrim(coalesce(p_to_location,'')));
  if v_from = '' or v_to = '' then
    return jsonb_build_object('status','error','reason','invalid_location');
  end if;
  if v_from = v_to then
    return jsonb_build_object('status','error','reason','same_location');
  end if;

  if p_scope = 'product' then
    select count(*) into v_cnt from inventory where id = p_target_id;
    if v_cnt <> 1 then
      return jsonb_build_object('status','error','reason','missing_inventory');
    end if;
    select product_id into v_pid from inventory where id = p_target_id for update;
    perform 1 from shelf_stock where inventory_id = p_target_id for update;

    select quantity into v_src from shelf_stock where inventory_id = p_target_id and location = v_from;
    if v_src is null then
      return jsonb_build_object('status','error','reason','placement_not_found');
    end if;
    if v_src < 0 then
      return jsonb_build_object('status','error','reason','inventory_inconsistent');
    end if;
    select quantity into v_dst from shelf_stock where inventory_id = p_target_id and location = v_to;
    if v_dst is not null and v_dst < 0 then
      return jsonb_build_object('status','error','reason','inventory_inconsistent');
    end if;
    v_moved := v_src;
    v_merge_big := coalesce(v_dst,0)::bigint + v_src::bigint;
    if v_merge_big > 2147483647 then
      return jsonb_build_object('status','error','reason','overflow');
    end if;

    begin
      delete from shelf_stock where inventory_id = p_target_id and location = v_from;
      insert into shelf_stock (inventory_id, location, quantity, updated_at)
      values (p_target_id, v_to, v_merge_big::int, now())
      on conflict (inventory_id, location) do update set quantity = excluded.quantity, updated_at = now();
      select coalesce(sum(quantity),0) into v_stock from shelf_stock where inventory_id = p_target_id;
      select location into v_primary from shelf_stock
        where inventory_id = p_target_id and quantity > 0
        order by quantity desc, location asc limit 1;
      update inventory set stock_quantity = v_stock::int, location = v_primary, updated_at = now()
       where id = p_target_id;
      get diagnostics v_rows = row_count;
      if v_rows <> 1 then raise exception 'inv4c_rowcount'; end if;
    exception when others then
      return jsonb_build_object('status','error','reason','apply_failed');
    end;

    return jsonb_build_object(
      'status','applied','op','move_shelf','scope','product',
      'inventoryId', p_target_id, 'productId', v_pid,
      'fromLocation', v_from, 'toLocation', v_to, 'quantity', v_moved,
      'stock', v_stock, 'primaryLocation', v_primary
    );
  else
    select parent_product_id into v_pid from product_variants where id = p_target_id;
    if not found then
      return jsonb_build_object('status','error','reason','missing_variant');
    end if;
    if v_pid is null then
      return jsonb_build_object('status','error','reason','missing_parent');
    end if;
    perform 1 from product_variants where parent_product_id = v_pid order by sku, id for update;
    perform 1 from variant_shelf_stock where variant_id = p_target_id for update;
    select count(*) into v_cnt from inventory where product_id = v_pid;
    if v_cnt <> 1 then
      return jsonb_build_object('status','error','reason','inventory_inconsistent');
    end if;
    select id into v_inv_id from inventory where product_id = v_pid for update;

    select quantity into v_src from variant_shelf_stock where variant_id = p_target_id and location = v_from;
    if v_src is null then
      return jsonb_build_object('status','error','reason','placement_not_found');
    end if;
    if v_src < 0 then
      return jsonb_build_object('status','error','reason','inventory_inconsistent');
    end if;
    select quantity into v_dst from variant_shelf_stock where variant_id = p_target_id and location = v_to;
    if v_dst is not null and v_dst < 0 then
      return jsonb_build_object('status','error','reason','inventory_inconsistent');
    end if;
    v_moved := v_src;
    v_merge_big := coalesce(v_dst,0)::bigint + v_src::bigint;
    if v_merge_big > 2147483647 then
      return jsonb_build_object('status','error','reason','overflow');
    end if;

    begin
      delete from variant_shelf_stock where variant_id = p_target_id and location = v_from;
      insert into variant_shelf_stock (variant_id, location, quantity, updated_at)
      values (p_target_id, v_to, v_merge_big::int, now())
      on conflict (variant_id, location) do update set quantity = excluded.quantity, updated_at = now();
      -- variant stock is Σ its shelves (invariant under a move, recomputed anyway).
      select coalesce(sum(quantity),0) into v_stock from variant_shelf_stock where variant_id = p_target_id;
      update product_variants set stock_quantity = v_stock::int where id = p_target_id;
      get diagnostics v_rows = row_count;
      if v_rows <> 1 then raise exception 'inv4c_rowcount'; end if;
      select coalesce(sum(stock_quantity),0) into v_pstock
        from product_variants where parent_product_id = v_pid;
      update inventory set stock_quantity = v_pstock::int, updated_at = now() where id = v_inv_id;
      get diagnostics v_rows = row_count;
      if v_rows <> 1 then raise exception 'inv4c_rowcount'; end if;
    exception when others then
      return jsonb_build_object('status','error','reason','apply_failed');
    end;

    return jsonb_build_object(
      'status','applied','op','move_shelf','scope','variant',
      'variantId', p_target_id, 'parentProductId', v_pid, 'inventoryId', v_inv_id,
      'fromLocation', v_from, 'toLocation', v_to, 'quantity', v_moved,
      'variantStock', v_stock, 'parentStock', v_pstock
    );
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants — server / service-role only (identical policy to the INV.3C/4A/4B RPCs).
-- ---------------------------------------------------------------------------
revoke all on function public.inv_place_shelf(text, uuid, text, integer) from public;
revoke all on function public.inv_place_shelf(text, uuid, text, integer) from anon;
revoke all on function public.inv_place_shelf(text, uuid, text, integer) from authenticated;
grant execute on function public.inv_place_shelf(text, uuid, text, integer) to service_role;

revoke all on function public.inv_replace_shelf_distribution(text, uuid, jsonb) from public;
revoke all on function public.inv_replace_shelf_distribution(text, uuid, jsonb) from anon;
revoke all on function public.inv_replace_shelf_distribution(text, uuid, jsonb) from authenticated;
grant execute on function public.inv_replace_shelf_distribution(text, uuid, jsonb) to service_role;

revoke all on function public.inv_assign_full_shelf(text, uuid, text, integer) from public;
revoke all on function public.inv_assign_full_shelf(text, uuid, text, integer) from anon;
revoke all on function public.inv_assign_full_shelf(text, uuid, text, integer) from authenticated;
grant execute on function public.inv_assign_full_shelf(text, uuid, text, integer) to service_role;

revoke all on function public.inv_move_shelf(text, uuid, text, text) from public;
revoke all on function public.inv_move_shelf(text, uuid, text, text) from anon;
revoke all on function public.inv_move_shelf(text, uuid, text, text) from authenticated;
grant execute on function public.inv_move_shelf(text, uuid, text, text) to service_role;
