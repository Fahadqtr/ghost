-- RAFEEQ.PKGJOB — down migration (manual use only; never auto-applied).
-- Removes the jobs table. The storage bucket is intentionally left in place —
-- it may hold generated artifacts the owner still wants; delete it manually
-- from the dashboard after confirming nothing needs to be kept.

drop table if exists public.rafeeq_package_jobs;
