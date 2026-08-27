-- SNOONU CATALOG SYNC — allow the scoped-repair audit mode.
--
-- 20260828000000_snoonu_sync_audits.sql is ALREADY APPLIED in production and
-- is therefore treated as immutable history: it created the table with
-- import_mode restricted to ('FULL','PARTIAL'). The scoped repair records its
-- run as import_mode = 'REPAIR', so the constraint has to widen — additively,
-- in a NEW migration, never by editing the applied one.
--
-- Scope: exactly one CHECK constraint on public.snoonu_sync_audits. No table
-- is recreated, no column is added or dropped, no row is read or written, and
-- nothing outside this table is touched. The constraint NAME is preserved
-- (snoonu_sync_audits_import_mode_check — verified against the live schema,
-- the name Postgres generated for the original inline CHECK) so history stays
-- coherent.
--
-- Existing rows are preserved: DROP/ADD CONSTRAINT never rewrites the table,
-- and the new value set is a strict superset of the old one, so every row
-- that satisfied the previous constraint still satisfies this one — the ADD's
-- validation pass cannot fail on existing data.
--
-- To reverse (manual): drop the constraint and re-add it without 'REPAIR' —
-- only safe while no audit row carries import_mode = 'REPAIR'.

alter table public.snoonu_sync_audits
  drop constraint if exists snoonu_sync_audits_import_mode_check;

alter table public.snoonu_sync_audits
  add constraint snoonu_sync_audits_import_mode_check
  check (import_mode in ('FULL','PARTIAL','REPAIR'));
