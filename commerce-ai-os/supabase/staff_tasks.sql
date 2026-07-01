-- Employee tasks. The manager assigns tasks (to one employee or to everyone);
-- employees see and complete theirs on /staff. Read/written server-side via the
-- service-role key. Run once in the Supabase SQL editor.

create table if not exists public.staff_tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  assigned_to uuid references public.staff_members(id) on delete cascade, -- null = everyone
  assigned_name text,                 -- snapshot of the employee name for display
  priority text not null default 'normal',   -- 'low' | 'normal' | 'high'
  due_date date,
  status text not null default 'open',        -- 'open' | 'in_progress' | 'done'
  created_by text,                    -- manager email
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  completed_by text
);

create index if not exists staff_tasks_assigned_idx on public.staff_tasks (assigned_to);
create index if not exists staff_tasks_status_idx on public.staff_tasks (status);

alter table public.staff_tasks enable row level security;

drop policy if exists "staff_tasks owner full access" on public.staff_tasks;
create policy "staff_tasks owner full access" on public.staff_tasks
  for all to authenticated using (true) with check (true);
