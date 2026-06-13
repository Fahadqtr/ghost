-- ============================================================================
-- Rollback for loop_state_layer.sql — drops everything that migration created.
--
-- WARNING: this DROPS the live-memory tables. Any data written after the
-- migration is lost:
--   * loop_log  → all event history
--   * loop_state → all saved per-loop memory
-- Run only to fully undo the Live Memory Layer. Idempotent (IF EXISTS).
-- ============================================================================

drop policy if exists loop_state_read_authenticated on loop_state;
drop policy if exists loop_log_read_authenticated on loop_log;

drop view  if exists loop_board;
drop table if exists loop_log;
drop table if exists loop_state;
