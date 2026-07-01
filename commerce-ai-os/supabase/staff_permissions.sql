-- Per-employee permissions for the /staff page. Each employee's granted
-- capabilities (stock / products / prices / malak / reports) are stored as a
-- JSON array. Existing employees default to stock-only (their current behaviour).
-- Run once in the Supabase SQL editor.

alter table public.staff_members
  add column if not exists permissions jsonb not null default '["stock"]'::jsonb;
