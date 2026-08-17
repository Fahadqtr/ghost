// OPS.8B — pure transition engine tests.
// node --conditions=react-server --experimental-strip-types --test lib/lifecycle/transitions.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import {
  LIFECYCLE_TRANSITION_RULES,
  findTransitionRule,
  evaluateTransition,
  availableTransitions,
  displayLifecycle,
  isKnownLifecycleState,
  type LifecycleContext,
} from "./transitions.ts";

const READY: LifecycleContext = { ready: true, archived: false };
const NOT_READY: LifecycleContext = { ready: false, archived: false };
const ARCHIVED: LifecycleContext = { ready: false, archived: true };

test("matrix contains exactly the five certified edges with correct authority", () => {
  const edges = LIFECYCLE_TRANSITION_RULES.map((r) => `${r.from}->${r.to}:${r.authority}:${r.requiresReady}`).sort();
  assert.deepEqual(edges, [
    "ACTIVE->DRAFT:owner:false",
    "ACTIVE->STOPPED:owner:false",
    "DRAFT->ACTIVE:writer:true",
    "STOPPED->ACTIVE:owner:true",
    "STOPPED->DRAFT:owner:false",
  ]);
});

test("DRAFT -> ACTIVE requires READY (writer)", () => {
  const ok = evaluateTransition("DRAFT", "ACTIVE", READY);
  assert.equal(ok.code, "OK");
  assert.equal(ok.allowed, true);
  assert.equal(ok.authority, "writer");

  const blocked = evaluateTransition("DRAFT", "ACTIVE", NOT_READY);
  assert.equal(blocked.code, "BLOCKED");
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.authority, "writer");
  assert.ok(blocked.reasons.length > 0);
});

test("ACTIVE -> STOPPED is allowed without readiness (owner)", () => {
  const d = evaluateTransition("ACTIVE", "STOPPED", NOT_READY);
  assert.equal(d.code, "OK");
  assert.equal(d.authority, "owner");
});

test("STOPPED -> ACTIVE requires READY (owner)", () => {
  assert.equal(evaluateTransition("STOPPED", "ACTIVE", READY).code, "OK");
  assert.equal(evaluateTransition("STOPPED", "ACTIVE", READY).authority, "owner");
  assert.equal(evaluateTransition("STOPPED", "ACTIVE", NOT_READY).code, "BLOCKED");
});

test("STOPPED -> DRAFT and ACTIVE -> DRAFT are owner, no readiness gate", () => {
  assert.equal(evaluateTransition("STOPPED", "DRAFT", NOT_READY).code, "OK");
  assert.equal(evaluateTransition("STOPPED", "DRAFT", NOT_READY).authority, "owner");
  assert.equal(evaluateTransition("ACTIVE", "DRAFT", NOT_READY).code, "OK");
  assert.equal(evaluateTransition("ACTIVE", "DRAFT", NOT_READY).authority, "owner");
});

test("same-state is UNCHANGED, not a write", () => {
  for (const s of ["DRAFT", "ACTIVE", "STOPPED"] as const) {
    const d = evaluateTransition(s, s, READY);
    assert.equal(d.code, "UNCHANGED");
    assert.equal(d.allowed, false);
  }
});

test("unknown edges are INVALID (no arbitrary transitions)", () => {
  // DRAFT -> STOPPED is deliberately NOT in the matrix
  const d = evaluateTransition("DRAFT", "STOPPED", READY);
  assert.equal(d.code, "INVALID");
  assert.equal(d.allowed, false);
  assert.equal(d.authority, null);
});

test("archived product blocks every transition (restore is the only path back)", () => {
  for (const to of ["ACTIVE", "STOPPED", "DRAFT"] as const) {
    const d = evaluateTransition("DRAFT", to, ARCHIVED);
    assert.equal(d.code, "ARCHIVED");
    assert.equal(d.allowed, false);
  }
  assert.deepEqual(availableTransitions("DRAFT", ARCHIVED), []);
});

test("availableTransitions annotates allowedNow by readiness", () => {
  const fromDraftReady = availableTransitions("DRAFT", READY);
  assert.deepEqual(fromDraftReady.map((t) => t.to), ["ACTIVE"]);
  assert.equal(fromDraftReady[0].allowedNow, true);

  const fromDraftNotReady = availableTransitions("DRAFT", NOT_READY);
  assert.equal(fromDraftNotReady[0].allowedNow, false);
  assert.ok(fromDraftNotReady[0].blockedReason);

  const fromActive = availableTransitions("ACTIVE", NOT_READY).map((t) => t.to).sort();
  assert.deepEqual(fromActive, ["DRAFT", "STOPPED"]);

  const fromStopped = availableTransitions("STOPPED", NOT_READY);
  // STOPPED->ACTIVE blocked (not ready), STOPPED->DRAFT allowed
  const toActive = fromStopped.find((t) => t.to === "ACTIVE");
  const toDraft = fromStopped.find((t) => t.to === "DRAFT");
  assert.equal(toActive?.allowedNow, false);
  assert.equal(toDraft?.allowedNow, true);
});

test("displayLifecycle derives READY (DRAFT+ready) and ARCHIVED, never stores them", () => {
  assert.equal(displayLifecycle("DRAFT", { ready: true, archived: false }), "READY");
  assert.equal(displayLifecycle("DRAFT", { ready: false, archived: false }), "DRAFT");
  assert.equal(displayLifecycle("ACTIVE", { ready: true, archived: false }), "ACTIVE"); // never READY when ACTIVE
  assert.equal(displayLifecycle("STOPPED", { ready: true, archived: false }), "STOPPED");
  assert.equal(displayLifecycle("DRAFT", { ready: true, archived: true }), "ARCHIVED"); // archived wins
});

test("findTransitionRule + isKnownLifecycleState", () => {
  assert.ok(findTransitionRule("DRAFT", "ACTIVE"));
  assert.equal(findTransitionRule("DRAFT", "STOPPED"), null);
  assert.equal(isKnownLifecycleState("ACTIVE"), true);
  for (const bad of ["READY", "ARCHIVED", "PUBLISHED", "HIDDEN", ""]) {
    assert.equal(isKnownLifecycleState(bad), false);
  }
});
