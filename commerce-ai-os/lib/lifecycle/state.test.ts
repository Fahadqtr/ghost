// OPS.8A — lifecycle read-compat tests. PURE.
// node --conditions=react-server --experimental-strip-types --test lib/lifecycle/state.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { LIFECYCLE_STATES, isLifecycleState, mapLegacyStatus, resolveLifecycleState, isReady } from "./state.ts";

test("lifecycle domain is exactly DRAFT/ACTIVE/STOPPED (no ARCHIVED/READY/PUBLISHED/HIDDEN)", () => {
  assert.deepEqual([...LIFECYCLE_STATES], ["DRAFT", "ACTIVE", "STOPPED"]);
  for (const forbidden of ["ARCHIVED", "READY", "PUBLISHED", "HIDDEN", "NOT_LISTED", "Active", "Draft"]) {
    assert.equal((LIFECYCLE_STATES as readonly string[]).includes(forbidden), false, `${forbidden} is not a stored lifecycle state`);
    assert.equal(isLifecycleState(forbidden), false);
  }
});

test("mapLegacyStatus: Active → ACTIVE, everything else → DRAFT", () => {
  assert.equal(mapLegacyStatus("Active"), "ACTIVE");
  for (const v of ["Draft", "", null, undefined, "Archived", "whatever"]) {
    assert.equal(mapLegacyStatus(v), "DRAFT");
  }
});

test("resolveLifecycleState prefers a valid lifecycle_state, else the legacy mapping", () => {
  assert.equal(resolveLifecycleState({ lifecycle_state: "STOPPED", platform_status: "Active" }), "STOPPED");
  assert.equal(resolveLifecycleState({ lifecycle_state: "ACTIVE" }), "ACTIVE");
  // invalid/absent lifecycle_state → fall back to platform_status
  assert.equal(resolveLifecycleState({ lifecycle_state: "ARCHIVED", platform_status: "Active" }), "ACTIVE");
  assert.equal(resolveLifecycleState({ platform_status: "Active" }), "ACTIVE");
  assert.equal(resolveLifecycleState({ platform_status: "Draft" }), "DRAFT");
  assert.equal(resolveLifecycleState(null), "DRAFT");
});

test("READY is derived: only a complete AND approved DRAFT is ready", () => {
  assert.equal(isReady("DRAFT", { readinessComplete: true, approved: true }), true);
  assert.equal(isReady("DRAFT", { readinessComplete: true, approved: false }), false);
  assert.equal(isReady("DRAFT", { readinessComplete: false, approved: true }), false);
  assert.equal(isReady("ACTIVE", { readinessComplete: true, approved: true }), false);
  assert.equal(isReady("STOPPED", { readinessComplete: true, approved: true }), false);
});
