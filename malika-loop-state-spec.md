# Malika AI — Live Memory Layer (`loop_state`)

**Goal:** Give the manager + 8 specialist agents durable, shared memory that lives in Supabase — not in the chat. Agents read state before acting and write state after acting, so context survives across runs.

**Implements:** "Repo remembers, Agent forgets" + "Skills store context" — adapted to a Supabase stack.
**Principle:** State on disk beats state in context. Fail closed — a run isn't "done" until its state is persisted.

---

## 1. The Three Layers

| Layer | Table | Role | Maps to |
|---|---|---|---|
| Live snapshot | `loop_state` | Current status of each (agent × loop). Updatable. | `status.md` + `next-up.md` |
| History | `loop_log` | Append-only event log. Never overwritten. | `done-log.md` |
| Manager board | `loop_board` (VIEW) | Aggregated live view for orchestration + briefing | `board.view` |

---

## 2. Supabase Schema

### 2.1 `loop_state` — live snapshot (one row per agent × loop)

```sql
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
```

### 2.2 `loop_log` — append-only history (durable + shareable)

```sql
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
```

### 2.3 `loop_board` — manager view (orchestration + morning briefing)

```sql
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
```

---

## 3. The Read → Act → Persist Loop (pseudocode)

Every agent task follows this exact order. Never start blind, never finish without persisting.

```text
function runAgentTask(agent_key, loop_key):
    run_id = uuid()

    # 1. LOAD — read state BEFORE acting
    state = select * from loop_state where agent_key=? and loop_key=?  (single)
    if state is null:
        state = upsert default row (status='idle', run_count=0)
    log(agent_key, loop_key, 'started', run_id)

    # 2. ACT — do the work using carried-over context
    result = doWork(goal=state.goal, context=state.context, resume=state.next_action)

    # 3. PERSIST — write state AFTER acting (this IS the memory)
    ok = upsert loop_state {
        agent_key, loop_key,
        status:      result.status,        # running/blocked/done/error
        last_task:   result.task,
        last_result: result.summary,
        next_action: result.next,
        context:     result.new_context,
        run_count:   state.run_count + 1,
        updated_at:  now()
    }

    # 4. LOG + GATE — not "done" until persisted
    if not ok:
        retry x2; if still failing -> log 'error'; raise   # fail closed
    log(agent_key, loop_key, result.status, run_id, result.summary)
```

---

## 4. Manager Orchestration

The manager runs on a cadence (heartbeat). Each cycle:

```text
board = select * from loop_board          # already sorted: error -> blocked -> running -> idle
for row in board:
    if row.status == 'error'   -> dispatch fixer / escalate (#ESCALATE)
    if row.status == 'blocked' -> check if unblock condition met -> requeue
    if row.status == 'idle' and row.staleness > threshold -> dispatch the owning agent
Morning briefing = render(board)          # the existing briefing reads this view
```

This gives the manager a single source of truth instead of asking each agent "what did you do?".

---

## 5. Claude API Call — passing state in, getting state back

The agent's call includes its loaded state, and must return structured JSON to write back.

```json
{
  "model": "claude-opus-4-8",
  "max_tokens": 1024,
  "system": "You are the INVENTORY agent for Malika's Universe. You receive your prior loop_state and a task. Do the work, then return ONLY JSON: {\"status\":\"running|blocked|done|error\",\"task\":\"...\",\"summary\":\"...\",\"next\":\"...\",\"new_context\":{...}}. Never invent stock or prices. If you cannot verify data, set status=blocked and explain in summary.",
  "messages": [
    {
      "role": "user",
      "content": "{\"loop_key\":\"inventory_sync\",\"prior_state\":{\"goal\":\"Flag mismatches across Shopify/Snoonu/Talabat/Rafeeq\",\"next_action\":\"Resume from SKU batch 3\",\"context\":{\"last_batch\":2,\"flagged\":7}},\"task\":\"Run next inventory sync batch\"}"
    }
  ]
}
```

Expected return (written straight into `loop_state`):

```json
{
  "status": "running",
  "task": "Synced inventory batch 3 of 6",
  "summary": "Checked 200 SKUs; 4 new mismatches (Talabat stock behind). 11 total flagged.",
  "next": "Resume from SKU batch 4",
  "new_context": { "last_batch": 3, "flagged": 11 }
}
```

---

## 6. How It Connects to What You Already Have

| Existing piece | Link to loop_state |
|---|---|
| Morning briefing | Reads `loop_board` directly — no separate status gathering |
| Compliance Checker (Agent #9) | Writes its verdict run into `loop_log`; `loop_state` row tracks `compliance` loop status |
| `ai_drafts`, `platform_products` | Stay as data tables; `loop_state.context` holds pointers (ids/batches), not duplicated data |
| 8 specialist agents | Each gets one `agent_key`; one row per loop they own |

---

## 7. n8n Node Mapping

| Step | n8n node |
|---|---|
| Heartbeat trigger | `Schedule` |
| Read board | `Supabase` → Get rows from `loop_board` |
| Decide dispatch | `Code` node (apply priority order) |
| Route per agent | `Switch` |
| Run agent | `HTTP Request` → Anthropic Messages API (§5) |
| Parse return JSON | `Code` node |
| Persist snapshot | `Supabase` → Upsert `loop_state` |
| Append history | `Supabase` → Insert `loop_log` |
| Error/blocked alert | `Slack`/`WhatsApp` with `#ESCALATE` |

---

## 8. Testing Checklist

- [ ] Cold start: no row exists → run creates default `idle` row, run_count=0
- [ ] Continuity: run a loop twice → 2nd run sees 1st run's `context` and `next_action`
- [ ] run_count increments each run
- [ ] Blocked status: agent returns `blocked` → manager does NOT advance it, requeues when unblocked
- [ ] Staleness: an `idle` loop older than threshold gets picked up by the manager
- [ ] Board ordering: an `error` row sorts above `blocked` above `running` above `idle`
- [ ] Write-failure: simulate Supabase upsert failure → run is NOT logged as done, retries fire
- [ ] loop_log is append-only (no updates/deletes in normal flow)
- [ ] Morning briefing renders correctly from `loop_board`

---

## 9. Error Handling

| Failure | Fallback |
|---|---|
| `loop_state` read fails | Abort the run, alert. Do not act on missing state. |
| Agent returns non-JSON | Treat as `error`, log raw output in `loop_log.payload`, do not upsert a fake "done". |
| `loop_state` upsert fails | Retry x2 backoff. If still failing → log `error`, raise. Never claim done. |
| Concurrent writes to same row | Last-write-wins on `loop_state`; both events still captured in `loop_log`. |
| Agent stuck `running` too long | Manager flags stale `running` rows as suspected `error` for review. |

**Principle: a loop that didn't persist its state didn't happen.**

---

## 10. Final Implementation Checklist

- [ ] Create `loop_state` table + indexes
- [ ] Create `loop_log` table + indexes
- [ ] Create `loop_board` view
- [ ] Assign each of the 8 agents + manager a stable `agent_key`
- [ ] Define initial `loop_key`s (inventory_sync, price_audit, listing_pipeline, support_queue, compliance)
- [ ] Wire the Read → Act → Persist order into every agent task
- [ ] Point the morning briefing at `loop_board`
- [ ] Enforce the fail-closed write gate (no "done" without persisted state)
- [ ] Run all 9 test cases in Section 8
- [ ] Seed one live loop (inventory_sync) and watch 3 consecutive runs carry context forward
