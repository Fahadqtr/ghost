-- Two-way thread on each staff task: the employee and the manager can post
-- comments and attach an image or file. Run once in the Supabase SQL editor.

create table if not exists public.task_comments (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.staff_tasks(id) on delete cascade,
  author text,                         -- "staff:<name>" or the manager email
  role text not null default 'staff',  -- 'staff' | 'manager'
  body text,
  attachment_url text,
  attachment_type text,                -- 'image' | 'file'
  attachment_name text,
  created_at timestamptz not null default now()
);

create index if not exists task_comments_task_idx on public.task_comments (task_id, created_at);

alter table public.task_comments enable row level security;

drop policy if exists "task_comments owner full access" on public.task_comments;
create policy "task_comments owner full access" on public.task_comments
  for all to authenticated using (true) with check (true);
