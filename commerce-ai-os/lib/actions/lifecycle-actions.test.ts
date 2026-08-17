// OPS.8C — lifecycle Action Center adapter tests (PURE).
// node --conditions=react-server --experimental-strip-types --test lib/actions/lifecycle-actions.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { actionsFromLifecycle } from "./action-sources.ts";
import { normalizeAction } from "./action-model.ts";
import type { LifecycleActionRow } from "./lifecycle-source.server.ts";

const row = (over: Partial<LifecycleActionRow>): LifecycleActionRow => ({
  productId: "p1",
  sku: "mk1",
  name: "منتج",
  lifecycleState: "DRAFT",
  ready: true,
  approved: true,
  readinessPercent: 100,
  ...over,
});

test("READY_FOR_ACTIVATION is emitted only for a ready DRAFT", () => {
  const acts = actionsFromLifecycle([row({ productId: "p1", lifecycleState: "DRAFT", ready: true })]);
  assert.equal(acts.length, 1);
  assert.equal(acts[0].type, "READY_FOR_ACTIVATION");
  assert.equal(acts[0].source, "lifecycle");
  assert.equal(acts[0].entityId, "p1");
  assert.equal(acts[0].currentState, "مسودة (جاهز)");
  assert.equal(acts[0].suggestedState, "نشط");
});

test("READY false ⇒ no action; non-DRAFT ⇒ no action", () => {
  assert.deepEqual(actionsFromLifecycle([row({ ready: false })]), []);
  assert.deepEqual(actionsFromLifecycle([row({ lifecycleState: "ACTIVE", ready: true })]), []);
  assert.deepEqual(actionsFromLifecycle([row({ lifecycleState: "STOPPED", ready: true })]), []);
});

test("evidence is deterministic and the id is stable", () => {
  const a1 = actionsFromLifecycle([row({ productId: "abc", readinessPercent: 100 })])[0];
  const a2 = actionsFromLifecycle([row({ productId: "abc", readinessPercent: 100 })])[0];
  assert.equal(a1.id, "READY_FOR_ACTIVATION:lifecycle:abc");
  assert.deepEqual(a1.evidence, a2.evidence);
  assert.ok(a1.evidence.some((e) => e.label === "الجاهزية" && e.value === "100%"));
  assert.ok(a1.evidence.some((e) => e.label === "الاعتماد"));
});

test("workflowHref deep-links to the lifecycle review panel (validated param)", () => {
  const a = actionsFromLifecycle([row({ productId: "p9" })])[0];
  assert.equal(a.workflowHref, "/v2/catalog/p9?panel=lifecycle#lifecycle");
});

test("normalizeAction carries impact + lifecycle source through", () => {
  const a = normalizeAction(actionsFromLifecycle([row({})])[0]);
  assert.equal(a.source, "lifecycle");
  assert.ok(typeof a.impact === "string" && a.impact.length > 0);
  assert.equal(a.lane, "approval_required"); // info + not auto-eligible → owner review
});

test("no synthetic STOP / RESTORE / ARCHIVE candidates are emitted", () => {
  const acts = actionsFromLifecycle([
    row({ lifecycleState: "ACTIVE", ready: true }),
    row({ lifecycleState: "STOPPED", ready: false }),
    row({ lifecycleState: "DRAFT", ready: false }),
  ]);
  for (const t of ["STOP_CANDIDATE", "RESTORE_CANDIDATE", "ARCHIVE_CANDIDATE"]) {
    assert.equal(acts.some((a) => a.type === t), false, `${t} must not be synthesized`);
  }
});

test("empty / non-array inputs are safe", () => {
  assert.deepEqual(actionsFromLifecycle([]), []);
  assert.deepEqual(actionsFromLifecycle(null), []);
  assert.deepEqual(actionsFromLifecycle(undefined), []);
});
