-- Web-push subscriptions (run once in the production SQL editor — idempotent).
--
-- One row per browser/device the owner enabled notifications on. Endpoints are
-- unique (re-subscribing the same browser upserts, never duplicates). RLS is
-- enabled with NO policies: the anon/user keys can't touch it — only the
-- service-role key (API routes) reads and writes.

create table if not exists push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  label      text,                       -- optional device note ("جوال فهد")
  created_at timestamptz not null default now()
);

alter table push_subscriptions enable row level security;
