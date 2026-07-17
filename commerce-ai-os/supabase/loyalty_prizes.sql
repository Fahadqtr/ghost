-- Beauty Rewards — selectable prizes (Phase 2).
-- The owner adds one or more prizes (each an image + optional name). Active
-- prizes show on the customer's card page; once a customer completes the card
-- they pick which prize they want, and the choice is recorded so the owner
-- knows what to hand over at redemption. Run once in the SQL editor (idempotent).
--
-- Service-role only (RLS on, no policies) — same pattern as the other loyalty
-- tables. Prize images live in a public bucket so they render by URL.

create table if not exists public.loyalty_prizes (
  id          uuid primary key default gen_random_uuid(),
  name        text not null default '',
  image_path  text not null,
  image_url   text not null,
  active      boolean not null default true,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);

create index if not exists loyalty_prizes_active_idx
  on public.loyalty_prizes (active, sort_order, created_at);

alter table public.loyalty_prizes enable row level security;

-- Which prize the customer chose after completing their card (cleared on
-- redemption / reset). ON DELETE SET NULL so removing a prize doesn't wipe rows.
alter table public.loyalty_customers
  add column if not exists chosen_prize_id uuid
  references public.loyalty_prizes(id) on delete set null;

-- Public bucket for prize images (admin-uploaded; served by URL on the card).
insert into storage.buckets (id, name, public)
values ('loyalty-prizes', 'loyalty-prizes', true)
on conflict (id) do nothing;
