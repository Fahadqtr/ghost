-- Beauty Rewards loyalty card ("بطاقة مكافآت الجمال" — Malika's Universe).
-- Customers scan a printed QR, register (name + phone), and upload a screenshot
-- of the review they left on Snoonu. Each APPROVED screenshot stamps one heart;
-- five hearts = one free product. Run once in the production SQL editor
-- (idempotent).
--
-- Identity is the phone number (normalized to digits) so a customer's hearts
-- follow them across devices. Stamps are only granted after the owner/staff
-- approve the submission from /rewards in the admin app — never automatically,
-- so a fake or reused screenshot can't self-award a heart.
--
-- Both tables have RLS enabled with NO policies: the anon/user keys can't touch
-- them. Only the service-role key (public API routes + admin server actions)
-- reads and writes — same pattern as push_subscriptions / crm_customers.

-- One row per customer, keyed by their normalized phone.
create table if not exists public.loyalty_customers (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  phone             text not null unique,           -- digits only, e.g. "97455512345"
  stamps            integer not null default 0,     -- approved hearts in the CURRENT cycle (0..5)
  cycles_completed  integer not null default 0,     -- rewards earned & redeemed over time
  reward_ready_at   timestamptz,                    -- set when stamps first reaches the goal
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- One row per uploaded review screenshot awaiting / after review.
create table if not exists public.loyalty_submissions (
  id           uuid primary key default gen_random_uuid(),
  customer_id  uuid not null references public.loyalty_customers(id) on delete cascade,
  image_path   text not null,                        -- object path inside the bucket
  image_url    text not null,                        -- public URL for preview
  status       text not null default 'pending'
               check (status in ('pending', 'approved', 'rejected')),
  note         text,                                 -- optional reviewer note (reason for rejection)
  created_at   timestamptz not null default now(),
  reviewed_at  timestamptz
);

create index if not exists loyalty_submissions_pending_idx
  on public.loyalty_submissions (created_at desc)
  where status = 'pending';

create index if not exists loyalty_submissions_customer_idx
  on public.loyalty_submissions (customer_id, created_at desc);

alter table public.loyalty_customers   enable row level security;
alter table public.loyalty_submissions enable row level security;

-- Public storage bucket for the review screenshots. Public read (so the admin
-- preview + the customer's own confirmation can render the image by URL);
-- writes go through the service-role key only.
insert into storage.buckets (id, name, public)
values ('loyalty-reviews', 'loyalty-reviews', true)
on conflict (id) do nothing;
