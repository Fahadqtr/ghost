-- Per-employee codes for the /staff stock page.
-- Each employee gets a unique PIN; their stock IN/OUT movements are attributed by
-- name (malak_audit.agent = 'staff:<name>'). The owner manages them at /team.
-- Run once in the Supabase SQL editor.

create table if not exists public.staff_members (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  pin text not null unique,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.staff_members enable row level security;

-- The owner (authenticated) has full access; anon is blocked. The /staff page
-- itself reads/writes via the server-side service-role key, not the anon client.
drop policy if exists "staff_members owner full access" on public.staff_members;
create policy "staff_members owner full access" on public.staff_members
  for all to authenticated using (true) with check (true);
