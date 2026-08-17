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
  assert.deepEqual(b, { draft: 1, ready: 1, active: 2, stopped: 1, total: 5 });
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
  const zero = { draft: 0, ready: 0, active: 0, stopped: 0, total: 0 };
  assert.deepEqual(buildLifecycleBreakdown([]), zero);
  assert.deepEqual(buildLifecycleBreakdown(null), zero);
  assert.deepEqual(buildLifecycleBreakdown(undefined), zero);
});
