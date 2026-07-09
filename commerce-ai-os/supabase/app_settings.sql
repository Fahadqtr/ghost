-- ============================================================
-- app_settings — key/value store for system-wide toggles.
-- Run once in Supabase → SQL Editor.
-- ============================================================

create table if not exists app_settings (
  key        text primary key,
  value      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Service-role only (server actions). No policies → RLS denies anon/auth.
alter table app_settings enable row level security;
