// OPS.8B — lifecycle signal (read-only breakdown) tests. PURE.
// node --conditions=react-server --experimental-strip-types --test lib/operations/lifecycle-signal.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { buildLifecycleBreakdown } from "./lifecycle-signal.ts";

test("counts live products by derived display state", () => {
  const b = buildLifecycleBreakdown([
    { lifecycleState: "DRAFT", readinessStatus: "incomplete" },
    { lifecycleState: "DRAFT", readinessStatus: "ready" }, // derived READY
    { lifecycleState: "ACTIVE", readinessStatus: "ready" },
    { lifecycleState: "ACTIVE", readinessStatus: "incomplete" },
    { lifecycleState: "STOPPED", readinessStatus: "almost_ready" },
  ]);
  assert.deepEqual(b, { draft: 1, ready: 1, active: 2, stopped: 1, archived: 0, total: 5 });
});

test("archived count comes from the passed-in product_archive count (never live items)", () => {
  const b = buildLifecycleBreakdown([{ lifecycleState: "ACTIVE", readinessStatus: "ready" }], 12);
  assert.equal(b.archived, 12);
  assert.equal(b.total, 1); // total excludes archived
  // defensive: negative / NaN → 0
  assert.equal(buildLifecycleBreakdown([], -3).archived, 0);
  assert.equal(buildLifecycleBreakdown([], Number.NaN).archived, 0);
});

test("READY overlay applies only to DRAFT (a ready ACTIVE stays active)", () => {
  const b = buildLifecycleBreakdown([{ lifecycleState: "ACTIVE", readinessStatus: "ready" }]);
  assert.equal(b.active, 1);
  assert.equal(b.ready, 0);
});

test("legacy fallback: absent lifecycleState resolves from platform_status", () => {
  const b = buildLifecycleBreakdown([
    { platformStatus: "Active", readinessStatus: "incomplete" },
    { platformStatus: "Draft", readinessStatus: "incomplete" },
    { platformStatus: "", readinessStatus: "incomplete" },
  ]);
  assert.equal(b.active, 1);
  assert.equal(b.draft, 2);
});

test("empty / non-array inputs are safe", () => {
  const zero = { draft: 0, ready: 0, active: 0, stopped: 0, archived: 0, total: 0 };
  assert.deepEqual(buildLifecycleBreakdown([]), zero);
  assert.deepEqual(buildLifecycleBreakdown(null), zero);
  assert.deepEqual(buildLifecycleBreakdown(undefined), zero);
});
