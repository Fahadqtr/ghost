// Tests for the weekly staff-task report compute.
// Run: node --experimental-strip-types --test lib/tasks/weekly-report.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { computeWeeklyReport, type ReportTask } from "./weekly-report.ts";

const FROM = new Date("2026-07-01T00:00:00Z");
const TO = new Date("2026-07-08T00:00:00Z");
const MEMBERS = [
  { id: "m1", name: "Marow" },
  { id: "m2", name: "Sara" },
];

const task = (over: Partial<ReportTask>): ReportTask => ({
  assigned_to: null, status: "done", created_at: "2026-07-02T08:00:00Z",
  completed_at: "2026-07-02T12:00:00Z", completed_by: null, due_date: null, ...over,
});

test("attributes completions to the assignee and averages hours", () => {
  const r = computeWeeklyReport(
    [
      task({ assigned_to: "m1" }),                                         // 4h
      task({ assigned_to: "m1", completed_at: "2026-07-02T16:00:00Z" }),   // 8h
      task({ assigned_to: "m2" }),
    ],
    MEMBERS, FROM, TO,
  );
  const m1 = r.members.find((m) => m.id === "m1")!;
  assert.equal(m1.done, 2);
  assert.equal(m1.avgHours, 6);
  assert.equal(r.totals.done, 3);
  assert.equal(r.members[0].id, "m1"); // sorted by done desc
});

test("everyone-tasks count for whoever completed them (staff:<name>)", () => {
  const r = computeWeeklyReport(
    [task({ assigned_to: null, completed_by: "staff:Sara" })],
    MEMBERS, FROM, TO,
  );
  assert.equal(r.members.find((m) => m.id === "m2")!.done, 1);
});

test("outside-window completions and reopened tasks are excluded", () => {
  const r = computeWeeklyReport(
    [
      task({ assigned_to: "m1", completed_at: "2026-06-20T12:00:00Z", created_at: "2026-06-20T08:00:00Z" }),
      task({ assigned_to: "m1", status: "open", completed_at: null }),
    ],
    MEMBERS, FROM, TO,
  );
  assert.equal(r.members.find((m) => m.id === "m1")!.done, 0);
});

test("open / overdue snapshot and late deliveries", () => {
  const r = computeWeeklyReport(
    [
      task({ assigned_to: "m1", status: "open", completed_at: null, due_date: "2026-07-03" }), // overdue
      task({ assigned_to: "m1", status: "in_progress", completed_at: null }),                  // open, no due
      task({ assigned_to: "m2", due_date: "2026-07-01", completed_at: "2026-07-02T12:00:00Z" }), // late done
    ],
    MEMBERS, FROM, TO,
  );
  const m1 = r.members.find((m) => m.id === "m1")!;
  assert.equal(m1.open, 2);
  assert.equal(m1.overdue, 1);
  assert.equal(r.members.find((m) => m.id === "m2")!.late, 1);
  assert.equal(r.totals.open, 2);
  assert.equal(r.totals.overdue, 1);
});

test("created count follows the window", () => {
  const r = computeWeeklyReport(
    [
      task({ created_at: "2026-07-05T10:00:00Z", status: "open", completed_at: null }),
      task({ created_at: "2026-06-05T10:00:00Z", status: "open", completed_at: null }),
    ],
    MEMBERS, FROM, TO,
  );
  assert.equal(r.totals.created, 1);
});
