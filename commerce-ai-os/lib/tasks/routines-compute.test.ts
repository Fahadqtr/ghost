// Tests for the routine materialization core.
// Run: node --experimental-strip-types --test lib/tasks/routines-compute.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import {
  mapRoutine,
  dueRoutines,
  planRoutineTasks,
  type RoutineRow,
} from "./routines-compute.ts";

// ---- mapRoutine -------------------------------------------------------------

test("mapRoutine normalizes defensively (bad priority/frequency, null weekday)", () => {
  const r = mapRoutine({ id: 7, priority: "urgent", frequency: "monthly", weekday: null });
  assert.equal(r.id, "7");                 // stringified
  assert.equal(r.title, "");               // missing → empty
  assert.equal(r.priority, "normal");      // unknown priority → normal
  assert.equal(r.frequency, "daily");      // anything not weekly → daily
  assert.equal(r.weekday, null);
  assert.equal(r.active, true);            // missing active → true
});

test("mapRoutine keeps valid values and active:false", () => {
  const r = mapRoutine({ id: "a", title: "Count shelves", priority: "high", frequency: "weekly", weekday: "3", active: false });
  assert.equal(r.priority, "high");
  assert.equal(r.frequency, "weekly");
  assert.equal(r.weekday, 3);              // numeric coercion
  assert.equal(r.active, false);
});

// ---- dueRoutines ------------------------------------------------------------

const daily: RoutineRow = { id: 1, title: "d", frequency: "daily" };
const wedWeekly: RoutineRow = { id: 2, title: "w", frequency: "weekly", weekday: 3 };

test("daily routines are due every day; weekly only on their weekday", () => {
  assert.deepEqual(dueRoutines([daily, wedWeekly], 3).map((r) => r.id), [1, 2]); // Wednesday
  assert.deepEqual(dueRoutines([daily, wedWeekly], 5).map((r) => r.id), [1]);    // Friday
});

test("weekly weekday is compared numerically (string weekday from DB)", () => {
  const w: RoutineRow = { id: 9, frequency: "weekly", weekday: "0" };
  assert.equal(dueRoutines([w], 0).length, 1); // Sunday
  assert.equal(dueRoutines([w], 1).length, 0);
});

// ---- planRoutineTasks -------------------------------------------------------

const TODAY = "2026-07-03";

test("plans one open task per due routine with routine linkage", () => {
  const rows = planRoutineTasks([{ id: 5, title: "Restock", priority: "high", created_by: "manager" }], [], TODAY);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    title: "Restock",
    description: null,
    assigned_to: null,
    assigned_name: null,
    priority: "high",
    due_date: TODAY,
    status: "open",
    created_by: "manager",
    routine_id: 5,
    routine_date: TODAY,
  });
});

test("skips routines already materialized today (string-matched ids)", () => {
  const due: RoutineRow[] = [{ id: 1, title: "a" }, { id: 2, title: "b" }];
  const rows = planRoutineTasks(due, ["1"], TODAY); // numeric id vs string set
  assert.deepEqual(rows.map((r) => r.routine_id), [2]);
});

test("unknown priority falls back to normal; missing created_by → routine", () => {
  const rows = planRoutineTasks([{ id: 1, title: "x", priority: "urgent" }], [], TODAY);
  assert.equal(rows[0].priority, "normal");
  assert.equal(rows[0].created_by, "routine");
});

test("everything already materialized → empty plan", () => {
  const rows = planRoutineTasks([{ id: 1 }, { id: 2 }], ["1", "2"], TODAY);
  assert.deepEqual(rows, []);
});
