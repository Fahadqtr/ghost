-- DOWN migration for 20260913000000_loop_board_authenticated_only.sql (manual).
--
-- Restores the EXACT pre-change state of public.loop_board recorded before the
-- up migration ran:
--
--   relacl      postgres=arwdDxtm/postgres  anon=arwdDxtm/postgres
--               authenticated=arwdDxtm/postgres  service_role=arwdDxtm/postgres
--   reloptions  (none)   -- i.e. security_invoker unset, view runs as owner
--
-- Running this REOPENS the unauthenticated read/write path through the view.
-- It exists so the change is reversible, not because reverting is advisable.
-- No rows are touched either way, so the rollback is lossless.

-- 1. Put the view back to owner-privilege execution (bypasses loop_state RLS).
alter view public.loop_board set (security_invoker = false);

-- 2. Restore the original blanket grants.
grant select, insert, update, delete, truncate, references, trigger
  on public.loop_board to anon, authenticated;
