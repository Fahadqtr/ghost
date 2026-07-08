-- Catalog-change tasks (run once in the production SQL editor — idempotent).
--
-- Every manual catalog change (add / edit / delete / image / approval) opens a
-- staff task automatically, carrying the product snapshot in `payload` so the
-- assignee can copy the data into Talabat/Snoonu/Rafeeq by hand — and so a
-- later platform-export upload can VERIFY the entry.
--
-- kind:      'manual' (owner-created, current behavior) | 'catalog' (auto)
-- product_id: the product the change touched (null for bulk summaries)
-- payload:    jsonb {action, snapshot, changes[]}
--
-- Unassigned 'catalog' tasks are visible ONLY to the manager (triage) —
-- staff see them once assigned. Unassigned 'manual' tasks keep meaning
-- "everyone", unchanged.

alter table public.staff_tasks add column if not exists kind text not null default 'manual';
alter table public.staff_tasks add column if not exists product_id uuid;
alter table public.staff_tasks add column if not exists payload jsonb;

create index if not exists staff_tasks_kind_idx on public.staff_tasks (kind, status);
