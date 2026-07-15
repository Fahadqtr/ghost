-- Google Calendar link for staff tasks. Stores the Google event id on each task
-- so the app can update/remove the matching calendar event in place (no dupes).
-- Run ONCE in the Supabase SQL editor of the PRODUCTION project
-- (vqstcmattiarhblqshvb). NEVER run against the legacy project. Safe to re-run.
--
-- Until this runs, the calendar sync is skipped (the app won't create untracked
-- duplicate events); tasks keep working normally.

alter table public.staff_tasks
  add column if not exists gcal_event_id text;
