-- Contract test for process_shopify_order_deduction against REAL uuid-typed
-- tables (products.id / inventory.id / inventory.product_id = uuid). It \i's the
-- migration for the function under test, seeds uuid rows, and asserts behaviour.
--
-- THROWAWAY DATABASE ONLY — it DROPs and recreates public.shopify_synced_orders,
-- public.inventory and public.products. Run with:
--   psql "<throwaway_db>" -v ON_ERROR_STOP=1 -v allow_destructive=1 \
--        -f supabase/shopify_synced_orders_deduction.test.sql
-- (run from the commerce-ai-os/supabase directory so the \i path resolves).

\if :{?allow_destructive}
\else
\echo '*** Refusing to run: pass -v allow_destructive=1 and use a THROWAWAY database only. ***'
\quit
\endif

-- Roles referenced by the migration's grants (exist already on Supabase).
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
end $$;

drop table if exists public.shopify_synced_orders;
drop table if exists public.inventory;
drop table if exists public.products;

create table public.products (id uuid primary key);
create table public.inventory (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null,
  stock_quantity int
);
create table public.shopify_synced_orders (
  order_id text primary key,
  order_name text,
  deducted int not null default 0,
  channel text not null default 'shopify',
  payment_gateway_names jsonb,
  synced_at timestamptz default now()
);

\i shopify_synced_orders_deduction.sql

-- Seed uuid-typed catalog + stock.
insert into public.products(id) values
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222'),
  ('33333333-3333-3333-3333-333333333333');
insert into public.inventory(id, product_id, stock_quantity) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 5),
  ('aaaaaaaa-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 3),
  ('bbbbbbbb-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222', 9),
  ('cccccccc-0000-0000-0000-000000000001', '33333333-3333-3333-3333-333333333333', 7);

-- A) uuid product_id succeeds; duplicate ids aggregate; biggest-row-first.
do $$
declare r jsonb; s1 int; s2 int;
begin
  r := public.process_shopify_order_deduction(
    'gid://A', '#A', 'shopify', '[]'::jsonb,
    '[{"product_id":"11111111-1111-1111-1111-111111111111","quantity":2},
      {"product_id":"11111111-1111-1111-1111-111111111111","quantity":3}]'::jsonb, false);
  if r->>'status' <> 'processed' then raise exception 'A: expected processed, got %', r; end if;
  if jsonb_array_length(r->'products') <> 1 then raise exception 'A: duplicates not aggregated: %', r->'products'; end if;
  select stock_quantity into s1 from public.inventory where id = 'aaaaaaaa-0000-0000-0000-000000000001';
  select stock_quantity into s2 from public.inventory where id = 'aaaaaaaa-0000-0000-0000-000000000002';
  if s1 <> 0 or s2 <> 3 then raise exception 'A: wrong stock s1=% s2=% (expected 0,3)', s1, s2; end if;
  raise notice 'A ok: uuid succeeds, duplicates aggregated (5 from biggest row)';
end $$;

-- B) same order id twice -> already_processed, no second deduction.
do $$
declare r jsonb; s1 int;
begin
  r := public.process_shopify_order_deduction(
    'gid://A', '#A', 'shopify', '[]'::jsonb,
    '[{"product_id":"11111111-1111-1111-1111-111111111111","quantity":1}]'::jsonb, false);
  if r->>'status' <> 'already_processed' then raise exception 'B: expected already_processed, got %', r; end if;
  select stock_quantity into s1 from public.inventory where id = 'aaaaaaaa-0000-0000-0000-000000000001';
  if s1 <> 0 then raise exception 'B: stock changed on duplicate: %', s1; end if;
  raise notice 'B ok: same order id twice -> exactly one deduction';
end $$;

-- C) invalid uuid -> raises AND rolls back the claim and any stock change.
do $$
declare raised boolean := false; cnt int; s int;
begin
  begin
    perform public.process_shopify_order_deduction(
      'gid://BAD', '#BAD', 'shopify', '[]'::jsonb,
      '[{"product_id":"not-a-uuid","quantity":1}]'::jsonb, false);
  exception when others then raised := true;
  end;
  if not raised then raise exception 'C: expected exception on invalid uuid'; end if;
  select count(*) into cnt from public.shopify_synced_orders where order_id = 'gid://BAD';
  if cnt <> 0 then raise exception 'C: ledger row not rolled back'; end if;
  select stock_quantity into s from public.inventory where id = 'bbbbbbbb-0000-0000-0000-000000000001';
  if s <> 9 then raise exception 'C: stock changed despite rollback: %', s; end if;
  raise notice 'C ok: invalid uuid rolls back claim + stock';
end $$;

-- D) malformed quantities (negative, non-integer, non-number) each roll back.
do $$
declare raised boolean; cnt int;
begin
  for raised, cnt in
    select false, 0
  loop null; end loop;
  -- negative
  raised := false;
  begin perform public.process_shopify_order_deduction('gid://Q1','#Q1','shopify','[]'::jsonb,
    '[{"product_id":"22222222-2222-2222-2222-222222222222","quantity":-1}]'::jsonb, false);
  exception when others then raised := true; end;
  if not raised then raise exception 'D: negative quantity not rejected'; end if;
  -- non-integer
  raised := false;
  begin perform public.process_shopify_order_deduction('gid://Q2','#Q2','shopify','[]'::jsonb,
    '[{"product_id":"22222222-2222-2222-2222-222222222222","quantity":1.5}]'::jsonb, false);
  exception when others then raised := true; end;
  if not raised then raise exception 'D: non-integer quantity not rejected'; end if;
  -- non-number
  raised := false;
  begin perform public.process_shopify_order_deduction('gid://Q3','#Q3','shopify','[]'::jsonb,
    '[{"product_id":"22222222-2222-2222-2222-222222222222","quantity":"abc"}]'::jsonb, false);
  exception when others then raised := true; end;
  if not raised then raise exception 'D: non-number quantity not rejected'; end if;
  select count(*) into cnt from public.shopify_synced_orders where order_id in ('gid://Q1','gid://Q2','gid://Q3');
  if cnt <> 0 then raise exception 'D: a malformed-quantity order was recorded'; end if;
  raise notice 'D ok: malformed quantities rejected + rolled back';
end $$;

-- E) p_deductions not an array -> raises + rolls back.
do $$
declare raised boolean := false; cnt int;
begin
  begin perform public.process_shopify_order_deduction('gid://NA','#NA','shopify','[]'::jsonb,
    '{"product_id":"x"}'::jsonb, false);
  exception when others then raised := true; end;
  if not raised then raise exception 'E: non-array p_deductions not rejected'; end if;
  select count(*) into cnt from public.shopify_synced_orders where order_id = 'gid://NA';
  if cnt <> 0 then raise exception 'E: non-array order recorded'; end if;
  raise notice 'E ok: non-array p_deductions rejected';
end $$;

-- F) clamp: deduct more than stock -> stock hits 0, never negative.
do $$
declare r jsonb; s int;
begin
  r := public.process_shopify_order_deduction('gid://CLAMP','#C','shopify','[]'::jsonb,
    '[{"product_id":"22222222-2222-2222-2222-222222222222","quantity":100}]'::jsonb, false);
  if r->>'status' <> 'processed' then raise exception 'F: %', r; end if;
  select stock_quantity into s from public.inventory where id = 'bbbbbbbb-0000-0000-0000-000000000001';
  if s <> 0 then raise exception 'F: not clamped to zero: %', s; end if;
  raise notice 'F ok: clamps at zero';
end $$;

-- G) baseline -> recorded, deducts nothing.
do $$
declare r jsonb; s int;
begin
  r := public.process_shopify_order_deduction('gid://BASE','#B','shopify','[]'::jsonb,
    '[{"product_id":"33333333-3333-3333-3333-333333333333","quantity":2}]'::jsonb, true);
  if r->>'status' <> 'baseline_recorded' then raise exception 'G: %', r; end if;
  select stock_quantity into s from public.inventory where id = 'cccccccc-0000-0000-0000-000000000001';
  if s <> 7 then raise exception 'G: baseline deducted: %', s; end if;
  raise notice 'G ok: baseline records without deduction';
end $$;

-- H) channel comes through verbatim (talabat).
do $$
declare c text;
begin
  perform public.process_shopify_order_deduction('gid://CH','#CH','talabat','["Talabat"]'::jsonb,'[]'::jsonb, false);
  select channel into c from public.shopify_synced_orders where order_id = 'gid://CH';
  if c <> 'talabat' then raise exception 'H: channel = %', c; end if;
  raise notice 'H ok: channel persisted';
end $$;

-- I) least privilege: anon/authenticated cannot execute; service_role can.
do $$
declare sig text := 'public.process_shopify_order_deduction(text,text,text,jsonb,jsonb,boolean)';
begin
  if has_function_privilege('anon', sig, 'execute') then raise exception 'I: anon can execute'; end if;
  if has_function_privilege('authenticated', sig, 'execute') then raise exception 'I: authenticated can execute'; end if;
  if not has_function_privilege('service_role', sig, 'execute') then raise exception 'I: service_role cannot execute'; end if;
  raise notice 'I ok: least privilege (service_role only)';
end $$;

-- J) the function casts to uuid and validates the uuid format (no uuid=text path).
do $$
declare def text;
begin
  def := pg_get_functiondef('public.process_shopify_order_deduction(text,text,text,jsonb,jsonb,boolean)'::regprocedure);
  if position('::uuid' in def) = 0 then raise exception 'J: no ::uuid cast present'; end if;
  if position('!~*' in def) = 0 then raise exception 'J: no uuid-format validation present'; end if;
  raise notice 'J ok: uuid cast + format validation present (A/C prove uuid=uuid at runtime)';
end $$;

\echo 'ALL SQL CONTRACT TESTS PASSED'
