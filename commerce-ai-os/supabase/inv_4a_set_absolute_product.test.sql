-- Contract test for inv_set_absolute_product against REAL uuid-typed tables.
-- THROWAWAY DATABASE ONLY. Run from the commerce-ai-os/supabase directory:
--   psql "<throwaway_db>" -v ON_ERROR_STOP=1 -v allow_destructive=1 \
--        -f inv_4a_set_absolute_product.test.sql
-- (NOT run in CI — the project's `pnpm test` is node --test over lib/**, app/**.)

\if :{?allow_destructive}
\else
\echo '*** Refusing to run: pass -v allow_destructive=1 and use a THROWAWAY database only. ***'
\quit
\endif

do $$ begin
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
end $$;

drop table if exists public.shelf_stock;
drop table if exists public.product_variants;
drop table if exists public.inventory;
drop table if exists public.products;

create table public.products (id uuid primary key, stock_status text);
create table public.inventory (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null,
  stock_quantity int,
  sold_quantity int default 0,   -- present ONLY to prove the RPC never touches it
  updated_at timestamptz default now()
);
create table public.product_variants (
  id uuid primary key default gen_random_uuid(),
  parent_product_id uuid not null,
  sku text,
  stock_quantity int
);
create table public.shelf_stock (
  id uuid primary key default gen_random_uuid(),
  inventory_id uuid not null,
  location text not null,
  quantity int,
  updated_at timestamptz default now(),
  unique (inventory_id, location)
);

\i migrations/20260814191448_inv_4a_set_absolute_product.sql

-- Fixtures: P1 simple; P2 variant product; P3 shelf-tracked simple.
do $$
declare p1 uuid:='11111111-1111-1111-1111-111111111111';
        p2 uuid:='22222222-2222-2222-2222-222222222222';
        p3 uuid:='33333333-3333-3333-3333-333333333333';
        inv3 uuid;
begin
  insert into products (id) values (p1),(p2),(p3);
  insert into inventory (id, product_id, stock_quantity) values ('a0000000-0000-0000-0000-000000000001', p1, 5);
  insert into inventory (product_id, stock_quantity) values (p2, 9);
  insert into product_variants (parent_product_id, sku, stock_quantity) values (p2,'p2-a',4),(p2,'p2-b',5);
  insert into inventory (product_id, stock_quantity) values (p3, 10) returning id into inv3;
  insert into shelf_stock (inventory_id, location, quantity) values (inv3, 'A1', 10);
end $$;

-- 1. valid absolute set on a simple product → applied + before/after/productId
do $$
declare r jsonb; ts timestamptz;
begin
  select updated_at into ts from inventory where id='a0000000-0000-0000-0000-000000000001';
  r := inv_set_absolute_product('a0000000-0000-0000-0000-000000000001', 12);
  assert r->>'status'='applied', 'set status: '||r::text;
  assert (r->>'before')::int=5 and (r->>'after')::int=12, 'before/after';
  assert (r->>'productId')='11111111-1111-1111-1111-111111111111', 'productId';
  assert (select stock_quantity from inventory where id='a0000000-0000-0000-0000-000000000001')=12, 'persisted';
  assert (select updated_at from inventory where id='a0000000-0000-0000-0000-000000000001') >= ts, 'updated_at advanced';
end $$;

-- 2. zero allowed
do $$
declare r jsonb;
begin
  r := inv_set_absolute_product('a0000000-0000-0000-0000-000000000001', 0);
  assert r->>'status'='applied' and (r->>'after')::int=0, 'zero allowed';
end $$;

-- 3. negative rejected
do $$
declare r jsonb;
begin
  r := inv_set_absolute_product('a0000000-0000-0000-0000-000000000001', -1);
  assert r->>'status'='error' and r->>'reason'='invalid_quantity', 'negative rejected';
end $$;

-- 4. missing inventory rejected
do $$
declare r jsonb;
begin
  r := inv_set_absolute_product('99999999-9999-9999-9999-999999999999', 3);
  assert r->>'reason'='missing_inventory', 'missing inventory';
end $$;

-- 5. NULL current stock → inventory_inconsistent (fail-closed, not coalesced)
do $$
declare r jsonb;
begin
  update inventory set stock_quantity=null where id='a0000000-0000-0000-0000-000000000001';
  r := inv_set_absolute_product('a0000000-0000-0000-0000-000000000001', 3);
  assert r->>'reason'='inventory_inconsistent', 'null current rejected';
  update inventory set stock_quantity=0 where id='a0000000-0000-0000-0000-000000000001'; -- restore
end $$;

-- 6. negative current stock → inventory_inconsistent
do $$
declare r jsonb;
begin
  update inventory set stock_quantity=-4 where id='a0000000-0000-0000-0000-000000000001';
  r := inv_set_absolute_product('a0000000-0000-0000-0000-000000000001', 3);
  assert r->>'reason'='inventory_inconsistent', 'negative current rejected';
  update inventory set stock_quantity=0 where id='a0000000-0000-0000-0000-000000000001'; -- restore
end $$;

-- 7. product with variants rejected
do $$
declare r jsonb; inv2 uuid;
begin
  select id into inv2 from inventory where product_id='22222222-2222-2222-2222-222222222222';
  r := inv_set_absolute_product(inv2, 20);
  assert r->>'reason'='product_has_variants', 'variant product rejected';
  assert (select stock_quantity from inventory where id=inv2)=9, 'variant parent unchanged';
end $$;

-- 8. shelf-tracked product rejected
do $$
declare r jsonb; inv3 uuid;
begin
  select id into inv3 from inventory where product_id='33333333-3333-3333-3333-333333333333';
  r := inv_set_absolute_product(inv3, 20);
  assert r->>'reason'='product_has_shelf_rows', 'shelf-tracked rejected';
  assert (select stock_quantity from inventory where id=inv3)=10, 'shelf-tracked master unchanged';
end $$;

-- 9. no availability / sold_quantity mutation anywhere
do $$
begin
  assert (select count(*) from products where stock_status is not null)=0, 'products.stock_status untouched';
  assert (select coalesce(sum(sold_quantity),0) from inventory)=0, 'sold_quantity untouched';
end $$;

\echo 'INV.4A inv_set_absolute_product contract test: ALL ASSERTIONS PASSED'
