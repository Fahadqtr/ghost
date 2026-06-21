// Phase 1 tests — malika-loop-state-spec.md §8 testing checklist (9 cases).
// Run: node --experimental-strip-types --test lib/loop/loopState.test.ts
//
// Uses an in-memory FakeLoopClient (no Supabase, no DB) that mimics the
// relevant Postgres behaviour: upsert-by-(agent_key,loop_key), append-only log,
// and a board mapped from loop_state. The DB view's ordering is mirrored by
// manager.sortBoard(), which is what the fake board uses.

import test from "node:test";
import assert from "node:assert/strict";

import { runAgentTask, loadState, LoopPersistError } from "./loopState.ts";
import { sortBoard, decideDispatch, renderBriefing } from "./manager.ts";
import type {
  LoopBoardRow,
  LoopClient,
  LoopLogInsert,
  LoopState,
  LoopStateUpsert,
} from "./types.ts";

class FakeLoopClient implements LoopClient {
  states = new Map<string, LoopState>();
  logs: LoopLogInsert[] = [];
  upsertAttempts = 0;
  failUpsert = false;
  private seq = 1;
  nowMs: number;
  constructor(nowMs: number = Date.now()) {
    this.nowMs = nowMs;
  }

  private k(a: string, l: string) {
    return `${a}::${l}`;
  }

  async getState(a: string, l: string): Promise<LoopState | null> {
    return this.states.get(this.k(a, l)) ?? null;
  }

  async upsertState(row: LoopStateUpsert) {
    this.upsertAttempts++;
    if (this.failUpsert) return { ok: false as const, error: "injected upsert failure" };
    const k = this.k(row.agent_key, row.loop_key);
    const prev = this.states.get(k);
    const saved: LoopState = {
      id: prev?.id ?? this.seq++,
      agent_key: row.agent_key,
      loop_key: row.loop_key,
      status: row.status,
      goal: row.goal ?? prev?.goal ?? null,
      last_task: row.last_task ?? null,
      last_result: row.last_result ?? null,
      next_action: row.next_action ?? null,
      context: row.context ?? {},
      run_count: row.run_count,
      updated_at: row.updated_at,
    };
    this.states.set(k, saved);
    return { ok: true as const, data: saved };
  }

  async insertLog(ev: LoopLogInsert) {
    this.logs.push(ev); // append-only: only ever grows
    return { ok: true as const };
  }

  async getBoard(): Promise<LoopBoardRow[]> {
    const rows: LoopBoardRow[] = [...this.states.values()].map((s) => ({
      loop_key: s.loop_key,
      agent_key: s.agent_key,
      status: s.status,
      goal: s.goal,
      next_action: s.next_action,
      run_count: s.run_count,
      updated_at: s.updated_at,
      staleness_ms: Math.max(0, this.nowMs - new Date(s.updated_at).getTime()),
    }));
    return sortBoard(rows);
  }
}

const fastOpts = { backoffMs: 1 };

// 1. Cold start: no row -> default idle row, run_count = 0 ---------------------
test("cold start creates a default idle row with run_count 0", async () => {
  const db = new FakeLoopClient();
  const seeded = await loadState(db, "inventory", "inventory_sync");
  assert.equal(seeded.status, "idle");
  assert.equal(seeded.run_count, 0);
  assert.ok(await db.getState("inventory", "inventory_sync"));
});

// 2. Continuity: 2nd run sees 1st run's context + next_action -----------------
// 3. run_count increments each run --------------------------------------------
test("continuity: context and next_action carry forward; run_count increments", async () => {
  const db = new FakeLoopClient();

  await runAgentTask(
    db,
    "inventory",
    "inventory_sync",
    async () => ({
      status: "running",
      task: "batch 1",
      summary: "did batch 1",
      next: "Resume from SKU batch 2",
      new_context: { last_batch: 1, flagged: 7 },
    }),
    fastOpts
  );

  let sawCarriedContext = false;
  const final = await runAgentTask(
    db,
    "inventory",
    "inventory_sync",
    async (input) => {
      // 2nd run must observe what the 1st run persisted
      assert.deepEqual(input.context, { last_batch: 1, flagged: 7 });
      assert.equal(input.resume, "Resume from SKU batch 2");
      sawCarriedContext = true;
      return {
        status: "running",
        task: "batch 2",
        summary: "did batch 2",
        next: "Resume from SKU batch 3",
        new_context: { last_batch: 2, flagged: 11 },
      };
    },
    fastOpts
  );

  assert.ok(sawCarriedContext);
  assert.equal(final.run_count, 2); // incremented once per run
  assert.deepEqual(final.context, { last_batch: 2, flagged: 11 });
});

// 4. Blocked: manager does NOT advance; requeues only when unblocked ----------
test("blocked status holds, then requeues when unblocked", async () => {
  const db = new FakeLoopClient();
  const state = await runAgentTask(
    db,
    "compliance",
    "listing_pipeline",
    async () => ({
      status: "blocked",
      task: "await human clearance",
      summary: "BLOCK verdict needs human",
      next: "resume after clearance",
      new_context: {},
    }),
    fastOpts
  );
  assert.equal(state.status, "blocked");

  const [row] = await db.getBoard();
  const held = decideDispatch(row, { stalenessThresholdMs: 0, isUnblocked: () => false });
  assert.equal(held.action, "hold");
  const requeued = decideDispatch(row, { stalenessThresholdMs: 0, isUnblocked: () => true });
  assert.equal(requeued.action, "requeue");
});

// 5. Staleness: an idle loop older than threshold gets dispatched -------------
test("idle loop dispatched only once it is stale", async () => {
  const now = Date.parse("2026-06-13T12:00:00Z");
  const stale: LoopBoardRow = {
    loop_key: "price_audit",
    agent_key: "pricing",
    status: "idle",
    goal: null,
    next_action: null,
    run_count: 3,
    updated_at: new Date(now - 10 * 60000).toISOString(), // 10 min old
    staleness_ms: 10 * 60000,
  };
  const fresh: LoopBoardRow = { ...stale, staleness_ms: 30 * 1000 }; // 30s old

  assert.equal(
    decideDispatch(stale, { stalenessThresholdMs: 5 * 60000 }).action,
    "dispatch"
  );
  assert.equal(
    decideDispatch(fresh, { stalenessThresholdMs: 5 * 60000 }).action,
    "skip"
  );
});

// 6. Board ordering: error > blocked > running > idle -------------------------
test("board sorts error > blocked > running > idle, then newest first", () => {
  const base = { goal: null, next_action: null, run_count: 0 } as const;
  const mk = (status: LoopBoardRow["status"], loop: string, ageMin: number): LoopBoardRow => ({
    ...base,
    loop_key: loop,
    agent_key: loop,
    status,
    updated_at: new Date(Date.now() - ageMin * 60000).toISOString(),
    staleness_ms: ageMin * 60000,
  });
  const sorted = sortBoard([
    mk("idle", "a", 1),
    mk("running", "b", 2),
    mk("error", "c", 3),
    mk("blocked", "d", 4),
  ]);
  assert.deepEqual(
    sorted.map((r) => r.status),
    ["error", "blocked", "running", "idle"]
  );
});

// 7. Write-failure: run is NOT logged done; retries fire (fail closed) --------
test("persist failure fails closed: throws, retries x2, no 'completed' log", async () => {
  const db = new FakeLoopClient();
  // Pre-seed a row so loadState does not need to upsert.
  await db.upsertState({
    agent_key: "inventory",
    loop_key: "inventory_sync",
    status: "running",
    run_count: 5,
    context: { last_batch: 4 },
    updated_at: new Date().toISOString(),
  });
  db.upsertAttempts = 0;
  db.failUpsert = true; // every persist now fails

  await assert.rejects(
    () =>
      runAgentTask(
        db,
        "inventory",
        "inventory_sync",
        async () => ({
          status: "done",
          task: "final batch",
          summary: "all synced",
          next: "",
          new_context: { last_batch: 6 },
        }),
        fastOpts
      ),
    LoopPersistError
  );

  assert.equal(db.upsertAttempts, 3, "1 initial + 2 retries");
  assert.ok(db.logs.some((l) => l.event === "started"));
  assert.ok(db.logs.some((l) => l.event === "error"));
  assert.ok(!db.logs.some((l) => l.event === "completed"), "never logs completed");

  const row = await db.getState("inventory", "inventory_sync");
  assert.equal(row?.status, "running", "state never flipped to done");
});

// 8. loop_log is append-only --------------------------------------------------
test("loop_log is append-only (no update/delete path; only grows)", async () => {
  const db = new FakeLoopClient();
  // The storage contract exposes no mutation of logs.
  assert.equal((db as unknown as Record<string, unknown>).updateLog, undefined);
  assert.equal((db as unknown as Record<string, unknown>).deleteLog, undefined);

  await runAgentTask(
    db,
    "inventory",
    "inventory_sync",
    async () => ({ status: "running", task: "t", summary: "s", next: "n", new_context: {} }),
    fastOpts
  );
  const afterFirst = db.logs.length;
  const snapshot = db.logs.map((l) => l.event);
  assert.ok(afterFirst >= 2); // started + completed

  await runAgentTask(
    db,
    "inventory",
    "inventory_sync",
    async () => ({ status: "running", task: "t2", summary: "s2", next: "n2", new_context: {} }),
    fastOpts
  );
  assert.ok(db.logs.length > afterFirst, "log only grows");
  // earlier entries are untouched
  assert.deepEqual(db.logs.slice(0, afterFirst).map((l) => l.event), snapshot);
});

// 9. Morning briefing renders from the board ----------------------------------
test("morning briefing renders from loop_board, error first", async () => {
  const db = new FakeLoopClient();
  const ts = new Date().toISOString();
  await db.upsertState({ agent_key: "pricing", loop_key: "price_audit", status: "idle", run_count: 2, updated_at: ts });
  await db.upsertState({ agent_key: "inventory", loop_key: "inventory_sync", status: "error", run_count: 9, updated_at: ts });

  const board = await db.getBoard();
  const briefing = renderBriefing(board, () => new Date("2026-06-13T06:00:00Z"));

  assert.match(briefing, /Morning Briefing/);
  assert.match(briefing, /price_audit/);
  assert.match(briefing, /inventory_sync/);
  // error loop is summarised/listed before the idle one
  assert.ok(briefing.indexOf("inventory_sync") < briefing.indexOf("price_audit"));

  // empty board renders cleanly
  assert.match(renderBriefing([], () => new Date("2026-06-13T06:00:00Z")), /No active loops/);
});
