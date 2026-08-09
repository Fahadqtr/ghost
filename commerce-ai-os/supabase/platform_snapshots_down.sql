-- ============================================================================
-- Rollback for supabase/platform_snapshots.sql (Phase UI.9.3).
-- Drops the snapshot table and its policies. Idempotent. This removes ALL
-- recorded snapshots (append-only history) but touches NOTHING else — products,
-- inventory, and platform_status are untouched, so the app degrades cleanly to
-- "Unknown" for PureSoul (never "missing"). Run in the Supabase SQL Editor.
-- ============================================================================

drop policy if exists platform_snapshots_insert on public.platform_snapshots;
drop policy if exists platform_snapshots_select on public.platform_snapshots;
drop index  if exists public.platform_snapshots_platform_captured_idx;
drop index  if exists public.platform_snapshots_latest_idx;
drop table  if exists public.platform_snapshots;
