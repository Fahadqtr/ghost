-- Auto-publish trigger via Supabase pg_cron (run once in the SQL editor).
--
-- Vercel Hobby crons fire at most once a day, so the 3-posts-a-day schedule
-- is driven from Supabase instead: every 15 minutes this pings the app's
-- publish endpoint, which posts any APPROVED plan rows whose time has come.
--
-- BEFORE RUNNING: replace YOUR_CRON_SECRET below with the CRON_SECRET value
-- from Vercel → ghost → Settings → Environment Variables.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Re-runnable: drop an older schedule with the same name first.
do $$
begin
  perform cron.unschedule('publish-social');
exception when others then null;
end $$;

select cron.schedule(
  'publish-social',
  '*/15 * * * *',
  $$
  select net.http_get(
    url     := 'https://app.malikasuniverse.com/api/cron/publish-social',
    headers := jsonb_build_object('Authorization', 'Bearer YOUR_CRON_SECRET')
  );
  $$
);
