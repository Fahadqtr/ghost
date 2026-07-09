-- Customer DM inbox (Instagram now, WhatsApp later).
-- Incoming messages arrive on /api/webhooks/meta; «ملاك» auto-replies using
-- the catalog + store info, and anything she can't handle is flagged
-- needs_human and surfaces in /inbox + the bell. Run once in the SQL editor.

create table if not exists public.dm_conversations (
  id          uuid primary key default gen_random_uuid(),
  channel     text not null default 'instagram',   -- 'instagram' | 'whatsapp'
  external_id text not null,                       -- IGSID / WhatsApp number
  username    text,                                -- display handle when known
  auto_reply  boolean not null default true,       -- per-conversation kill switch
  needs_human boolean not null default false,
  last_message_at timestamptz,
  last_preview text,
  created_at  timestamptz not null default now(),
  unique (channel, external_id)
);

create table if not exists public.dm_messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.dm_conversations(id) on delete cascade,
  direction       text not null,                   -- 'in' | 'out'
  body            text,
  mid             text,                            -- platform message id (dedupe)
  ai              boolean not null default false,  -- true = ملاك wrote it
  created_at      timestamptz not null default now()
);

create index if not exists dm_messages_conv_idx on public.dm_messages (conversation_id, created_at);
create unique index if not exists dm_messages_mid_idx on public.dm_messages (mid) where mid is not null;

-- Service-role access only (webhook + admin pages use the admin key).
alter table public.dm_conversations enable row level security;
alter table public.dm_messages enable row level security;
