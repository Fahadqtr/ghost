// Tests for the staff movement aggregation core.
// Run: node --experimental-strip-types --test lib/staff/stats-compute.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { aggregateStaffMovements, type StaffMovementRow } from "./stats-compute.ts";

const TODAY = Date.parse("2026-07-03T00:00:00Z");
const todayAt = "2026-07-03T09:00:00Z"; // after the boundary
const earlierWeek = "2026-06-30T09:00:00Z"; // this week, before today

const mv = (over: Partial<StaffMovementRow> & { details?: StaffMovementRow["details"] } = {}): StaffMovementRow => ({
  created_at: todayAt, action_type: "stock_in", agent: "staff:sara", details: { quantity: 1 }, ...over,
});

test("week counts every row; today counts only rows at/after the boundary", () => {
  const agg = aggregateStaffMovements([
    mv({ created_at: todayAt, action_type: "stock_in", details: { quantity: 3 } }),
    mv({ created_at: todayAt, action_type: "stock_out", details: { quantity: 2 } }),
    mv({ created_at: earlierWeek, action_type: "stock_in", details: { quantity: 5 } }), // week only
  ], TODAY);

  assert.deepEqual(agg.week, { in: 2, out: 1 });
  assert.deepEqual(agg.today, { in: 1, out: 1, inUnits: 3, outUnits: 2 }); // earlier-week IN excluded
});

test("review tallies: approved / reversed / everything-else-pending", () => {
  const agg = aggregateStaffMovements([
    mv({ details: { review: "approved", quantity: 1 } }),
    mv({ details: { review: "reversed", quantity: 1 } }),
    mv({ details: { review: "pending", quantity: 1 } }), // explicit pending
    mv({ details: { quantity: 1 } }),                    // no review → pending
  ], TODAY);
  assert.deepEqual(agg.review, { pending: 2, approved: 1, reversed: 1 });
});

test("per-employee (today) strips staff: prefix, falls back to agent, then '—'", () => {
  const agg = aggregateStaffMovements([
    mv({ agent: "staff:sara", details: { by: "staff:sara", quantity: 1 } }),
    mv({ agent: "staff:sara", action_type: "stock_out", details: { by: "staff:sara", quantity: 1 } }),
    mv({ agent: "staff:omar", details: { quantity: 1 } }),   // name from agent
    mv({ agent: null, details: { quantity: 1 } }),            // → "—"
  ], TODAY);

  const byName = Object.fromEntries(agg.byEmployeeToday.map((e) => [e.name, e]));
  assert.deepEqual(byName["sara"], { name: "sara", in: 1, out: 1 });
  assert.deepEqual(byName["omar"], { name: "omar", in: 1, out: 0 });
  assert.ok(byName["—"], "unnamed rows bucket under —");
  // sara has the most activity (2) → sorted first.
  assert.equal(agg.byEmployeeToday[0].name, "sara");
});

test("per-employee list is capped at the top 6 by activity", () => {
  const rows: StaffMovementRow[] = [];
  for (let i = 0; i < 9; i++) {
    // employee i logs (i+1) movements today → more activity for higher i
    for (let j = 0; j <= i; j++) rows.push(mv({ agent: `staff:e${i}`, details: { by: `staff:e${i}`, quantity: 1 } }));
  }
  const agg = aggregateStaffMovements(rows, TODAY);
  assert.equal(agg.byEmployeeToday.length, 6);
  assert.equal(agg.byEmployeeToday[0].name, "e8"); // busiest first
});

test("only today's rows appear in the per-employee breakdown", () => {
  const agg = aggregateStaffMovements([
    mv({ created_at: earlierWeek, agent: "staff:sara", details: { by: "staff:sara", quantity: 1 } }),
  ], TODAY);
  assert.deepEqual(agg.byEmployeeToday, []); // nothing today
  assert.deepEqual(agg.week, { in: 1, out: 0 }); // but still in the week total
});
