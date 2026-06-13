-- ============================================================================
-- Live Memory Layer — loop_state / loop_log / loop_board
-- Implements malika-loop-state-spec.md §2 (Supabase Schema).
--
-- Durable, shared memory for the manager + specialist agents: read state before
-- acting, write state after acting. "State on disk beats state in context."
--
-- Safe & idempotent (IF NOT EXISTS / CREATE OR REPLACE). Run in the Supabase
-- SQL editor (or `supabase db` pipeline). No data changes to existing tables.
-- ============================================================================

-- 2.1 loop_state — live snapshot (one row per agent × loop) ------------------
create table if not exists loop_state (
  id           bigint generated always as identity primary key,
  agent_key    text not null,   -- 'manager','inventory','pricing','listing','support','compliance', etc.
  loop_key     text not null,   -- 'inventory_sync','price_audit','listing_pipeline','support_queue'
  status       text not null default 'idle'
               check (status in ('idle','running','blocked','done','error')),
  goal         text,            -- current objective for this loop
  last_task    text,            -- what the agent just did
  last_result  text,            -- short outcome summary
  next_action  text,            -- planned next step (so the next run knows where to resume)
  context      jsonb not null default '{}',  -- structured carry-over: counts, ids, flags
  run_count    int  not null default 0,
  updated_at   timestamptz not null default now(),
  unique (agent_key, loop_key)
);

create index if not exists idx_loop_state_status on loop_state (status);

-- 2.2 loop_log — append-only history (durable + shareable) -------------------
-- Append-only by contract: the app layer only INSERTs here (see
-- lib/loop/supabaseLoopClient.ts — no update/delete path is exposed).
create table if not exists loop_log (
  id          bigint generated always as identity primary key,
  agent_key   text not null,
  loop_key    text not null,
  event       text not null,   -- 'started','completed','blocked','handoff','error'
  detail      text,
  payload     jsonb default '{}',
  run_id      uuid,            -- groups all events from a single run
  created_at  timestamptz not null default now()
);

create index if not exists idx_loop_log_loop on loop_log (loop_key, created_at desc);
create index if not exists idx_loop_log_agent on loop_log (agent_key, created_at desc);

-- 2.3 loop_board — manager view (orchestration + morning briefing) ----------
-- Pre-sorted: error -> blocked -> running -> idle, then most-recently-updated.
-- The TS reference for this ordering lives in lib/loop/manager.ts (sortBoard);
-- keep the two in sync.
create or replace view loop_board as
select
  loop_key,
  agent_key,
  status,
  goal,
  next_action,
  run_count,
  updated_at,
  now() - updated_at as staleness
from loop_state
order by
  case status
    when 'error'   then 0
    when 'blocked' then 1
    when 'running' then 2
    when 'idle'    then 3
    else 4
  end,
  updated_at desc;
