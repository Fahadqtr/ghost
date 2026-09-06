-- TALABAT DIRECT SEND — distinguish a TEST delivery from an official one.
--
-- Additive only: one column with a default, so every existing row keeps its
-- meaning ('official') and nothing is rewritten. No existing column changes
-- type or nullability, no data is mutated, no index is dropped.
--
-- Why a column and not a convention: a test send uses the same transport, the
-- same sender and the same attachments as the real thing. If the log cannot
-- tell them apart, a test row reads as evidence that Talabat was emailed —
-- which is exactly the confusion the test mode exists to avoid.

alter table public.talabat_email_deliveries
  add column if not exists delivery_mode text not null default 'official'
    check (delivery_mode in ('official', 'test'));

create index if not exists talabat_email_deliveries_mode_idx
  on public.talabat_email_deliveries (delivery_mode, sent_at desc);
