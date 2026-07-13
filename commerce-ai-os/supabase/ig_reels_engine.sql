-- ============================================================================
-- Instagram Reels engine — tag social_posts with format + CTA type
-- ----------------------------------------------------------------------------
-- Run ONCE in the Supabase SQL editor of the PRODUCTION project
-- (vqstcmattiarhblqshvb). NEVER run against the legacy project awlevukqqsaxvifrfteb.
--
-- We extend the existing social_posts table (no new queue table): every Reel
-- carries its UGC `format` (one of the 5) and `cta_type` (growth | conversion),
-- so the weekly per-format metrics review can group by format. Approval + the
-- publish cron + insights all keep working unchanged. Safe to re-run.
-- ============================================================================

alter table social_posts add column if not exists format text;      -- entertainment | street_interview | unboxing | review | asmr
alter table social_posts add column if not exists cta_type text;     -- growth | conversion

-- Fast grouping for the Sunday per-format review.
create index if not exists social_posts_format_idx
  on social_posts (format)
  where format is not null;

comment on column social_posts.format is
  'Reels UGC format: entertainment | street_interview | unboxing | review | asmr';
comment on column social_posts.cta_type is
  'Reels CTA phase: growth (follow/save/share) | conversion (order/link)';
