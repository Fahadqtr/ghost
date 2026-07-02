-- Recurring task routines (daily / weekly checklists). The manager defines a
-- routine; the system materializes a real staff_tasks row for each due day
-- (lazily, when tasks are listed) — the unique index guarantees exactly one
-- instance per routine per day. Run once in the Supabase SQL editor.

create table if not exists public.task_routines (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  assigned_to uuid references public.staff_members(id) on delete cascade, -- null = everyone
  assigned_name text,
  priority text not null default 'normal',      -- 'low' | 'normal' | 'high'
  frequency text not null default 'daily',      -- 'daily' | 'weekly'
  weekday int,                                  -- 0=Sunday … 6=Saturday (weekly only)
  active boolean not null default true,
  created_by text,
  created_at timestamptz not null default now()
);

alter table public.task_routines enable row level security;
drop policy if exists "task_routines owner full access" on public.task_routines;
create policy "task_routines owner full access" on public.task_routines
  for all to authenticated using (true) with check (true);

-- Link generated tasks back to their routine + the day they were generated for.
alter table public.staff_tasks
  add column if not exists routine_id uuid references public.task_routines(id) on delete cascade,
  add column if not exists routine_date date;

-- Exactly one generated instance per routine per day.
create unique index if not exists staff_tasks_routine_day_uidx
  on public.staff_tasks (routine_id, routine_date) where routine_id is not null;
