// Tests for the manager orchestration state machine.
// Run: node --conditions=react-server --experimental-strip-types --test lib/loop/manager.test.ts
//
// These pure functions decide what the heartbeat does with each loop (escalate /
// requeue / hold / dispatch / flag_stale / skip) and render the briefing. The DB
// loop_board view mirrors sortBoard(), so the ordering contract matters too.

import test from "node:test";
import assert from "node:assert/strict";

import { sortBoard, decideDispatch, planCycle, renderBriefing } from "./manager.ts";
import type { LoopBoardRow, LoopStatus } from "./types.ts";

function row(overrides: Partial<LoopBoardRow> = {}): LoopBoardRow {
  return {
    loop_key: "l1", agent_key: "a1", status: "idle" as LoopStatus, next_action: null,
    run_count: 0, updated_at: "2026-01-01T00:00:00.000Z", staleness_ms: 0, ...overrides,
  } as LoopBoardRow;
}

const ctx = { stalenessThresholdMs: 60_000, runningStaleMs: 600_000 };

test("sortBoard orders by status priority (error→blocked→running→idle→done)", () => {
  const board = [row({ status: "idle" }), row({ status: "error" }), row({ status: "running" }), row({ status: "blocked" })];
  assert.deepEqual(sortBoard(board).map((r) => r.status), ["error", "blocked", "running", "idle"]);
});

test("sortBoard breaks ties by updated_at descending (newest first)", () => {
  const board = [
    row({ loop_key: "old", status: "idle", updated_at: "2026-01-01T00:00:00.000Z" }),
    row({ loop_key: "new", status: "idle", updated_at: "2026-01-02T00:00:00.000Z" }),
  ];
  assert.deepEqual(sortBoard(board).map((r) => r.loop_key), ["new", "old"]);
});

test("decideDispatch: error escalates", () => {
  assert.equal(decideDispatch(row({ status: "error" }), ctx).action, "escalate");
});

test("decideDispatch: blocked requeues only when the unblock predicate passes", () => {
  assert.equal(decideDispatch(row({ status: "blocked" }), ctx).action, "hold"); // no predicate → hold
  assert.equal(decideDispatch(row({ status: "blocked" }), { ...ctx, isUnblocked: () => true }).action, "requeue");
});

test("decideDispatch: running flags stale past runningStaleMs, else skips", () => {
  assert.equal(decideDispatch(row({ status: "running", staleness_ms: 700_000 }), ctx).action, "flag_stale");
  assert.equal(decideDispatch(row({ status: "running", staleness_ms: 1_000 }), ctx).action, "skip");
});

test("decideDispatch: idle dispatches only past the staleness threshold", () => {
  assert.equal(decideDispatch(row({ status: "idle", staleness_ms: 90_000 }), ctx).action, "dispatch");
  assert.equal(decideDispatch(row({ status: "idle", staleness_ms: 10_000 }), ctx).action, "skip");
});

test("planCycle sorts the board then decides per loop (error first)", () => {
  const board = [row({ loop_key: "i", status: "idle", staleness_ms: 90_000 }), row({ loop_key: "e", status: "error" })];
  const decisions = planCycle(board, ctx);
  assert.deepEqual(decisions.map((d) => d.action), ["escalate", "dispatch"]);
});

test("renderBriefing summarizes an empty board", () => {
  const out = renderBriefing([], () => new Date("2026-06-01T09:00:00.000Z"));
  assert.match(out, /No active loops\./);
  assert.match(out, /2026-06-01T09:00:00\.000Z/);
});

test("renderBriefing lists loops with a status count summary", () => {
  const board = [row({ status: "error", loop_key: "boom" }), row({ status: "idle", loop_key: "calm" })];
  const out = renderBriefing(board, () => new Date("2026-06-01T09:00:00.000Z"));
  assert.match(out, /Loops: 2 \(1 error, 1 idle\)/);
  assert.match(out, /\[ERROR\] boom/);
  // error sorts above idle in the body
  assert.ok(out.indexOf("boom") < out.indexOf("calm"));
});
