-- ACC-01 — close the loop_board unauthenticated exposure.
--
-- WHAT WAS WRONG
-- public.loop_board is a VIEW over public.loop_state. It was created without
-- the security_invoker option, so it executed with the privileges of its OWNER
-- (postgres). Because loop_state has force_rls = false, the table owner is not
-- subject to that table's row-level security — so every query routed through
-- the view BYPASSED loop_state's RLS entirely.
--
-- On top of that, the view carried Supabase's default blanket schema grants:
-- anon and authenticated each held arwdDxtm (SELECT, INSERT, UPDATE, DELETE,
-- TRUNCATE, REFERENCES, TRIGGER). The view is a simple single-table projection,
-- which PostgreSQL reports as auto-updatable (information_schema.views:
-- is_updatable = YES, is_insertable_into = YES), and every NOT NULL column of
-- loop_state is either exposed by the view or defaulted (id is GENERATED ALWAYS
-- AS IDENTITY, context defaults '{}', status 'idle', run_count 0, updated_at
-- now()). So an UNAUTHENTICATED caller could read loop_state through the view,
-- and could also insert, update and delete rows in it.
--
-- Supabase's own database linter reported the same object as its only
-- ERROR-level security finding (security_definer_view).
--
-- THE INTENDED MODEL
-- supabase/loop_state_layer.sql states it plainly: server-side agents use the
-- SERVICE-ROLE key (which bypasses RLS); the browser keys are meant to allow
-- signed-in users to READ the board, with NO client-side writes. anon was never
-- an intended consumer — those grants came from the default schema-wide GRANT,
-- not from a deliberate decision. This migration restores that intent.
--
-- SCOPE
-- Touches public.loop_board ONLY: its ACL and its reloptions. It does not
-- change loop_state's policies or grants, does not touch any other object, and
-- does not modify a single row. The wider default-grant issue on other tables
-- (ACC-05) is deliberately NOT addressed here.
--
-- Down migration: 20260913000001_loop_board_authenticated_only_down.sql

-- 1. Remove all anonymous access to the view.
revoke all on public.loop_board from anon;

-- 2. Leave authenticated with read only. SELECT is deliberately retained so the
--    signed-in dashboard read described in loop_state_layer.sql keeps working.
revoke insert, update, delete, truncate, references, trigger
  on public.loop_board from authenticated;

-- 3. Make the view run as the CALLER instead of its owner, so loop_state's RLS
--    applies to it. This is the change that actually closes the bypass: with
--    security_invoker on, loop_state's only policy (SELECT for authenticated)
--    governs the view, and because loop_state has no INSERT/UPDATE/DELETE
--    policy at all, writes through the view are denied even independently of
--    the grants revoked above.
alter view public.loop_board set (security_invoker = true);
