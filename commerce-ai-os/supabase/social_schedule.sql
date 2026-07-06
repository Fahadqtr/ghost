-- Weekly plan columns (run once in the production SQL editor — idempotent).
--
-- scheduled_at: when the post should go live (UTC). approved: the owner's
-- explicit go-ahead on /social — the publish cron only ever touches rows with
-- approved = true, so nothing posts without a tap.

alter table social_posts add column if not exists scheduled_at timestamptz;
alter table social_posts add column if not exists approved boolean not null default false;

create index if not exists social_posts_due_idx
  on social_posts (scheduled_at)
  where status = 'pending' and approved = true;
