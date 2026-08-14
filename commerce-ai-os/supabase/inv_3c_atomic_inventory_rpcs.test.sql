-- Contract test for the INV.3C atomic inventory RPCs against REAL uuid-typed
-- tables. It \i's the migration under test, seeds uuid rows, and asserts
-- behaviour with plpgsql ASSERT.
--
-- THROWAWAY DATABASE ONLY — it DROPs and recreates public.products,
-- public.inventory, public.product_variants, public.shelf_stock and
-- public.variant_shelf_stock. Run from the commerce-ai-os/supabase directory:
--   psql "<throwaway_db>" -v ON_ERROR_STOP=1 -v allow_destructive=1 \
--        -f inv_3c_atomic_inventory_rpcs.test.sql
-- (NOT run in CI — the project's `pnpm test` is node --test over lib/**, app/**.)

\if :{?allow_destructive}
\else
\echo '*** Refusing to run: pass -v allow_destructive=1 and use a THROWAWAY database only. ***'
\quit
\endif

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
end $$;

drop table if exists public.variant_shelf_stock;
drop table if exists public.shelf_stock;
drop table if exists public.product_variants;
drop table if exists public.inventory;
drop table if exists public.products;

create table public.products (
  id uuid primary key,
  stock_status text            -- present ONLY to prove the RPCs never touch it
);
create table public.inventory (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null,
  stock_quantity int,
  sold_quantity int default 0, -- present ONLY to prove the RPCs never touch it
  updated_at timestamptz default now()
);
create table public.product_variants (
  id uuid primary key default gen_random_uuid(),
  parent_product_id uuid not null,
  sku text,
  stock_quantity int,
  stock_status text            -- present ONLY to prove the RPCs never touch it
);
create table public.shelf_stock (
  id uuid primary key default gen_random_uuid(),
  inventory_id uuid not null,
  location text not null,
  quantity int,
  updated_at timestamptz default now(),
  unique (inventory_id, location)
);
create table public.variant_shelf_stock (
  id uuid primary key default gen_random_uuid(),
  variant_id uuid not null,
  location text not null,
  quantity int,
  updated_at timestamptz default now(),
  unique (variant_id, location)
);

\i migrations/20260814181709_inv_3c_atomic_inventory_rpcs.sql

-- ── fixtures ────────────────────────────────────────────────────────────────
-- P1: variant product, two options (4 + 5 = parent 9), no shelves.
-- P2: simple product, no variants, product-level shelf.
-- P3: variant product, one option with variant shelves (sum 6 == stock 6).
do $$
declare
  p1 uuid := '11111111-1111-1111-1111-111111111111';
  p2 uuid := '22222222-2222-2222-2222-222222222222';
  p3 uuid := '33333333-3333-3333-3333-333333333333';
  inv2 uuid;
  v3 uuid;
begin
  insert into products (id) values (p1),(p2),(p3);

  insert into inventory (product_id, stock_quantity) values (p1, 9);
  insert into product_variants (id, parent_product_id, sku, stock_quantity)
    values ('aaaaaaaa-0000-0000-0000-000000000001', p1, 'p1-a', 4),
           ('aaaaaaaa-0000-0000-0000-000000000002', p1, 'p1-b', 5);

  insert into inventory (product_id, stock_quantity) values (p2, 10) returning id into inv2;
  -- (no shelves yet for p2)

  insert into inventory (product_id, stock_quantity) values (p3, 6);
  insert into product_variants (id, parent_product_id, sku, stock_quantity)
    values ('cccccccc-0000-0000-0000-000000000001', p3, 'p3-a', 6) returning id into v3;
  insert into variant_shelf_stock (variant_id, location, quantity) values (v3, 'A1', 6);
end $$;

-- ── 1. variant + positive delta → applied, parent rolls up ───────────────────
do $$
declare r jsonb;
begin
  r := inv_adjust_variant('aaaaaaaa-0000-0000-0000-000000000001', 3); -- 4 -> 7
  assert r->>'status' = 'applied', 'adjust+ status: '||r::text;
  assert (r->>'after')::int = 7, 'adjust+ after';
  assert (r->>'parentStock')::int = 12, 'adjust+ rollup (7+5)';
  assert (select stock_quantity from inventory where product_id='11111111-1111-1111-1111-111111111111') = 12, 'adjust+ parent persisted';
end $$;

-- ── 2. variant + valid negative delta → applied ──────────────────────────────
do $$
declare r jsonb;
begin
  r := inv_adjust_variant('aaaaaaaa-0000-0000-0000-000000000001', -2); -- 7 -> 5
  assert r->>'status' = 'applied', 'adjust- status';
  assert (r->>'after')::int = 5, 'adjust- after';
  assert (r->>'parentStock')::int = 10, 'adjust- rollup (5+5)';
end $$;

-- ── 3. insufficient stock rejected, no mutation ──────────────────────────────
do $$
declare r jsonb; before int;
begin
  select stock_quantity into before from product_variants where id='aaaaaaaa-0000-0000-0000-000000000002'; -- 5
  r := inv_adjust_variant('aaaaaaaa-0000-0000-0000-000000000002', -6);
  assert r->>'status' = 'error' and r->>'reason' = 'insufficient_stock', 'insufficient reason: '||r::text;
  assert (select stock_quantity from product_variants where id='aaaaaaaa-0000-0000-0000-000000000002') = before, 'insufficient no mutation';
end $$;

-- ── 4. NULL sibling → inventory_inconsistent (fail-closed) ───────────────────
do $$
declare r jsonb;
begin
  update product_variants set stock_quantity = null where id='aaaaaaaa-0000-0000-0000-000000000002';
  r := inv_adjust_variant('aaaaaaaa-0000-0000-0000-000000000001', 1);
  assert r->>'status' = 'error' and r->>'reason' = 'inventory_inconsistent', 'null sibling reason: '||r::text;
  update product_variants set stock_quantity = 5 where id='aaaaaaaa-0000-0000-0000-000000000002'; -- restore
end $$;

-- ── 5. negative (malformed) sibling → inventory_inconsistent ─────────────────
do $$
declare r jsonb;
begin
  update product_variants set stock_quantity = -3 where id='aaaaaaaa-0000-0000-0000-000000000002';
  r := inv_set_variant_absolute('aaaaaaaa-0000-0000-0000-000000000001', 4);
  assert r->>'status' = 'error' and r->>'reason' = 'inventory_inconsistent', 'neg sibling reason: '||r::text;
  update product_variants set stock_quantity = 5 where id='aaaaaaaa-0000-0000-0000-000000000002'; -- restore
end $$;

-- ── 6. absolute set → applied, parent rollup ─────────────────────────────────
do $$
declare r jsonb;
begin
  r := inv_set_variant_absolute('aaaaaaaa-0000-0000-0000-000000000001', 8); -- ->8
  assert r->>'status' = 'applied', 'set abs status';
  assert (r->>'after')::int = 8, 'set abs after';
  assert (r->>'parentStock')::int = 13, 'set abs rollup (8+5)';
end $$;

-- ── 7. absolute set negative rejected ────────────────────────────────────────
do $$
declare r jsonb;
begin
  r := inv_set_variant_absolute('aaaaaaaa-0000-0000-0000-000000000001', -1);
  assert r->>'status' = 'error' and r->>'reason' = 'invalid_quantity', 'set abs neg reason';
end $$;

-- ── 8. product shelf placement recomputes master ─────────────────────────────
do $$
declare r jsonb; inv2 uuid;
begin
  select id into inv2 from inventory where product_id='22222222-2222-2222-2222-222222222222';
  r := inv_place_shelf('product', inv2, 'a1', 30);  -- lowercase → normalized A1
  assert r->>'status' = 'applied', 'shelf product status: '||r::text;
  assert (r->>'location') = 'A1', 'shelf location normalized';
  assert (r->>'stock')::int = 30, 'shelf master recompute';
  assert (select stock_quantity from inventory where id=inv2) = 30, 'shelf master persisted';
  r := inv_place_shelf('product', inv2, 'B2', 5);
  assert (r->>'stock')::int = 35, 'shelf master sum two slots';
end $$;

-- ── 9. variant shelf placement recomputes variant + parent ───────────────────
do $$
declare r jsonb;
begin
  -- v3 currently A1=6 (variant stock 6). Change to 10 → variant 10, parent 10.
  r := inv_place_shelf('variant', 'cccccccc-0000-0000-0000-000000000001', 'A1', 10);
  assert r->>'status' = 'applied', 'variant shelf status: '||r::text;
  assert (r->>'variantStock')::int = 10, 'variant shelf recompute';
  assert (r->>'parentStock')::int = 10, 'variant shelf parent rollup';
  assert (select stock_quantity from product_variants where id='cccccccc-0000-0000-0000-000000000001') = 10, 'variant shelf persisted';
  assert (select stock_quantity from inventory where product_id='33333333-3333-3333-3333-333333333333') = 10, 'variant shelf parent persisted';
end $$;

-- ── 10. adjust on a shelf-tracked variant is rejected fail-closed ────────────
do $$
declare r jsonb;
begin
  r := inv_adjust_variant('cccccccc-0000-0000-0000-000000000001', 1);
  assert r->>'status' = 'error' and r->>'reason' = 'variant_has_shelf_rows', 'shelf-tracked adjust reason: '||r::text;
end $$;

-- ── 11. product shelf op on a variant product is rejected ────────────────────
do $$
declare r jsonb; inv1 uuid;
begin
  select id into inv1 from inventory where product_id='11111111-1111-1111-1111-111111111111';
  r := inv_place_shelf('product', inv1, 'A1', 1);
  assert r->>'status' = 'error' and r->>'reason' = 'product_has_variants', 'product-shelf on variant product';
end $$;

-- ── 12. missing ids / bad scope rejected ─────────────────────────────────────
do $$
declare r jsonb;
begin
  r := inv_adjust_variant('99999999-9999-9999-9999-999999999999', 1);
  assert r->>'reason' = 'missing_variant', 'missing variant';
  r := inv_place_shelf('product', '99999999-9999-9999-9999-999999999999', 'A1', 1);
  assert r->>'reason' = 'missing_inventory', 'missing inventory';
  r := inv_place_shelf('bogus', '11111111-1111-1111-1111-111111111111', 'A1', 1);
  assert r->>'reason' = 'invalid_scope', 'invalid scope';
  r := inv_place_shelf('product', (select id from inventory where product_id='22222222-2222-2222-2222-222222222222'), '   ', 1);
  assert r->>'reason' = 'invalid_location', 'invalid location';
end $$;

-- ── 13. NO availability / sold_quantity mutation by any of the above ──────────
do $$
begin
  assert (select count(*) from products where stock_status is not null) = 0, 'products.stock_status untouched';
  assert (select count(*) from product_variants where stock_status is not null) = 0, 'product_variants.stock_status untouched';
  assert (select coalesce(sum(sold_quantity),0) from inventory) = 0, 'inventory.sold_quantity untouched';
end $$;

\echo 'INV.3C RPC contract test: ALL ASSERTIONS PASSED'
