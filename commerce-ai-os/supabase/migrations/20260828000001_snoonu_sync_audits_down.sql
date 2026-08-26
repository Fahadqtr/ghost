-- DOWN migration for 20260828000000_snoonu_sync_audits.sql (manual use).

drop index if exists public.snoonu_sync_audits_applied_idx;
drop table if exists public.snoonu_sync_audits;
