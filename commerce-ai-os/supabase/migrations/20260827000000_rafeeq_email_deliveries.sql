-- RAFEEQ DIRECT SEND — minimal email delivery audit (additive only).
--
-- One row per SUCCESSFUL direct email send of a completed Rafeeq package.
-- This table is an audit log, NOT delivery state: recording a row here never
-- marks a rafeeq_packages row as sent — «تم الإرسال إلى رفيق» (sent_at on
-- rafeeq_packages) remains a separate explicit owner action.
-- Rows are inserted ONLY after the mail provider accepted the message.

create table if not exists public.rafeeq_email_deliveries (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null,
  package_id uuid null,
  sender text not null,
  recipients text[] not null,
  cc text[] not null default '{}',
  subject text not null,
  sent_at timestamptz not null,
  provider_message_id text null,
  attachment_filenames text[] not null default '{}',
  status text not null default 'sent' check (status = 'sent'),
  created_at timestamptz not null default now()
);

create index if not exists rafeeq_email_deliveries_job_idx
  on public.rafeeq_email_deliveries (job_id, sent_at desc);

alter table public.rafeeq_email_deliveries enable row level security;
-- service-role only (admin client); no anon/authenticated policies on purpose.
