-- TALABAT DIRECT SEND — minimal email delivery audit (additive only).
--
-- One row per SUCCESSFUL Talabat email send. Mirrors rafeeq_email_deliveries
-- and adds what the Talabat flow needs: which of the two sendable emails was
-- sent, who confirmed it, and a SAFE error reference.
--
-- This is an audit log, not delivery state: a row here never changes catalog,
-- marketplace or package state. Rows are inserted ONLY after the mail provider
-- accepted the message. No credential is stored — `sender` is the public From
-- header, nothing else about the transport is recorded.
--
-- `error_reference` is nullable and deliberately NOT the provider's raw text:
-- only an opaque reference may be written, so a provider message that happens
-- to echo a username or a connection string can never land in this table.

create table if not exists public.talabat_email_deliveries (
  id                   uuid primary key default gen_random_uuid(),
  -- barcode_corrections is intentionally NOT an allowed value: Email C can
  -- never be sent, so it can never be logged as sent either.
  email_kind           text not null check (email_kind in ('existing_updates', 'new_products')),
  sender               text not null,
  recipients           text[] not null,
  cc                   text[] not null default '{}',
  subject              text not null,
  sent_at              timestamptz not null,
  provider_message_id  text null,
  attachment_filenames text[] not null default '{}',
  status               text not null default 'sent' check (status = 'sent'),
  created_by           text not null,
  error_reference      text null,
  created_at           timestamptz not null default now()
);

create index if not exists talabat_email_deliveries_kind_idx
  on public.talabat_email_deliveries (email_kind, sent_at desc);

alter table public.talabat_email_deliveries enable row level security;
-- service-role only (admin client); no anon/authenticated policies on purpose.
