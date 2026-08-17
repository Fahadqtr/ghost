-- Rollback for supabase/export_runs.sql (INT.2E.2). Drops the durable
-- export/publish audit table and its policies/indexes. Safe to re-run.
drop policy if exists export_runs_select on public.export_runs;
drop policy if exists export_runs_insert on public.export_runs;
drop index if exists public.export_runs_destination_created_idx;
drop index if exists public.export_runs_actor_created_idx;
drop table if exists public.export_runs;
