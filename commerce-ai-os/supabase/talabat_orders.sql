-- talabat_orders — orders received from Talabat / Delivery Hero via the order
-- webhook. Run ONCE in the Supabase SQL editor of the PRODUCTION project
-- (vqstcmattiarhblqshvb). NEVER the legacy project. Safe to re-run.
--
-- The webhook stores the FULL raw payload (nothing lost) plus a few best-effort
-- extracted fields for the list view. Field mapping can be tightened later
-- against a real payload without a migration (raw is always kept).

create table if not exists public.talabat_orders (
  id            uuid primary key default gen_random_uuid(),
  received_at   timestamptz not null default now(),
  order_code    text,                 -- best-effort order id/code from the payload
  status        text,                 -- RECEIVED | READY_FOR_PICKUP | DISPATCHED | DELIVERED | CANCELED …
  customer_name text,
  total         numeric,
  currency      text,
  placed_at     timestamptz,
  items         jsonb,                -- [{sku,name,quantity,price}]
  raw           jsonb not null,       -- the untouched webhook body
  event         text                  -- event/type header or field, if any
);

create index if not exists talabat_orders_received_idx on public.talabat_orders (received_at desc);
create index if not exists talabat_orders_code_idx on public.talabat_orders (order_code);

alter table public.talabat_orders enable row level security;

drop policy if exists talabat_orders_select on public.talabat_orders;
create policy talabat_orders_select on public.talabat_orders
  for select to authenticated using (true);
-- Inserts come from the webhook via the service-role key (bypasses RLS).
