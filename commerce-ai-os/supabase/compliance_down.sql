-- ============================================================================
-- Rollback for compliance.sql — drops everything that migration created.
-- WARNING: drops compliance_log (all verdict history) and compliance_rules
-- (all configured rules/seed). Idempotent (IF EXISTS).
-- ============================================================================

drop policy if exists compliance_rules_read_authenticated on compliance_rules;
drop policy if exists compliance_log_read_authenticated on compliance_log;

drop table if exists compliance_log;
drop table if exists compliance_rules;
