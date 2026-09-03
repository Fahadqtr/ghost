// STEP 38 — Operations / Tasks / Actions master-scope proofs.
//
// The three surfaces mix CURRENT PRODUCT-DERIVED work with GLOBAL/SYSTEM and
// HISTORICAL data. These tests pin which of those scoping touches — and, just as
// importantly, which it must never touch.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { scopeActions, scopeActionCenterView, rescopeSources, isGlobalAction } from "./action-scope.ts";
import { buildActionCenter, summarizeActions, type ActionInput } from "./action-model.ts";

const strip = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

const OPS = "../../app/(v2)/v2/operations/page.tsx";
const TASKS = "../../app/(v2)/v2/tasks/page.tsx";
const ACTIONS = "../../app/(v2)/v2/actions/page.tsx";
const HOME = "../home/home-dashboard.server.ts";

const member = (...ids: string[]) => (id: string) => ids.includes(id);

// NOTE on fixture fidelity: `id` is supplied by the source (buildActionCenter
// de-duplicates on it), the `type` must be a real ACTION_TYPES member, and the
// LANE IS DERIVED by the model from severity/confidence/type — it is never
// passed in. The fixture therefore mirrors a real source emission.
let seq = 0;
function input(over: Partial<ActionInput> & { type: ActionInput["type"] }): ActionInput {
  seq += 1;
  return {
    id: `a${seq}`,
    source: "recommendation",
    severity: "warning",
    confidence: "medium",
    title: "t",
    entityId: null,
    ...over,
  } as ActionInput;
}

const view = (...inputs: ActionInput[]) => buildActionCenter(inputs, { generatedAt: "2026-01-01T00:00:00.000Z" });

// ── 3 & 4. product-derived actions follow membership ─────────────────────────

test("an outside-master product-derived action is excluded", () => {
  const v = view(
    input({ type: "PRICE_REVIEW", entityId: "m1" }),
    input({ type: "PRICE_REVIEW", entityId: "outside" }),
  );
  const scoped = scopeActionCenterView(v, member("m1"));
  assert.equal(scoped.actions.length, 1);
  assert.equal(scoped.actions[0].entityId, "m1");
});

test("a current-master product action remains visible", () => {
  const v = view(input({ type: "PRICE_REVIEW", entityId: "m1" }));
  assert.equal(scopeActionCenterView(v, member("m1")).actions.length, 1);
});

// ── 7. global / system actions are never dropped ─────────────────────────────

test("a global system action with no entity survives scoping", () => {
  const v = view(
    input({ type: "HEALTH_ALERT", entityId: null }),
    input({ type: "PRICE_REVIEW", entityId: "outside" }),
  );
  const scoped = scopeActionCenterView(v, member("m1"));
  assert.equal(scoped.actions.length, 1, "the global finding is kept, the outside product dropped");
  assert.equal(scoped.actions[0].entityId, null);
});

test("isGlobalAction treats null and empty entity ids as global", () => {
  assert.equal(isGlobalAction({ entityId: null }), true);
  assert.equal(isGlobalAction({ entityId: "" }), true);
  assert.equal(isGlobalAction({ entityId: "m1" }), false);
});

// ── 8. summary, groups and rows share one membership scope ───────────────────

test("summary, groups and the row list are all recounted over the SAME scoped set", () => {
  const v = view(
    input({ type: "PRICE_REVIEW", entityId: "m1", severity: "critical" }),
    input({ type: "IMAGE_REQUIRED", entityId: "outside", severity: "critical" }),
    input({ type: "HEALTH_ALERT", entityId: null, blocked: true }),
  );
  const scoped = scopeActionCenterView(v, member("m1"));
  assert.equal(scoped.summary.total, scoped.actions.length, "summary total === rows shown");
  assert.equal(scoped.summary.critical, 1, "the outside critical action is not counted");
  assert.equal(scoped.summary.waiting, 1);
  assert.equal(scoped.groups.reduce((n, g) => n + g.count, 0), scoped.actions.length,
    "group counts sum to the scoped row count");
  // The summary is the certified summarizer over the scoped list — no new rule.
  assert.deepEqual(scoped.summary, summarizeActions(scoped.actions));
});

// ── 9. lane/source counts report the unit actually shown ─────────────────────

test("per-source counts are recomputed post-scoping, preserving reader health", () => {
  const v = buildActionCenter(
    [input({ type: "PRICE_REVIEW", entityId: "m1" }), input({ type: "PRICE_REVIEW", entityId: "outside" })],
    { sources: [{ source: "recommendation", ok: true, count: 2 }, { source: "ops_health", ok: false, count: 0 }] },
  );
  const scoped = scopeActionCenterView(v, member("m1"));
  const rec = scoped.sources.find((s) => s.source === "recommendation");
  assert.equal(rec?.count, 1, "count reflects what is shown, not the pre-scope total");
  const health = scoped.sources.find((s) => s.source === "ops_health");
  assert.equal(health?.ok, false, "a degraded source stays degraded — scoping never repairs it");
});

test("action lane counts are labelled as ACTIONS, not products", () => {
  const ui = src("../../components/v2/actions/ActionCenter.tsx");
  assert.ok(/إجراءات<\/span>/.test(ui), "lane tiles carry the actions unit");
  assert.ok(/\{s\.count\} إجراء/.test(ui), "source chips carry the actions unit");
  const page = src(ACTIONS);
  assert.ok(/الإجراءات<\/strong>/.test(page), "the page states the unit explicitly");
  assert.ok(/وليس بعدد المنتجات/.test(page), "and states it is NOT a product count");
});

// ── 11. membership failure fails closed for product-derived data ─────────────

test("membership failure drops product actions but keeps global findings", () => {
  const v = view(
    input({ type: "PRICE_REVIEW", entityId: "m1" }),
    input({ type: "HEALTH_ALERT", entityId: null }),
  );
  const scoped = scopeActionCenterView(v, member("m1"), /* membershipOk */ false);
  assert.equal(scoped.actions.length, 1, "no product-bound action survives an unreadable membership");
  assert.equal(scoped.actions[0].entityId, null, "the surviving one is the global finding");
  assert.equal(scoped.summary.total, 1);
});

test("scopeActions never falls back to the unfiltered list", () => {
  const actions = view(input({ type: "PRICE_REVIEW", entityId: "m1" })).actions;
  assert.deepEqual(scopeActions(actions, () => false, true), []);
  assert.deepEqual(scopeActions(null, member("m1")), []);
  assert.deepEqual(rescopeSources(null, []), []);
});

// ── 1 & 2. Operations and Tasks scope their one current array ────────────────

test("Operations scopes the single items array that feeds every current queue", () => {
  const s = strip(src(OPS));
  assert.ok(/const scope = await loadMasterScope\(\)/.test(s), "uses the shared membership seam");
  assert.ok(/scopeRows\(result\.data\.items, \(r\) => r\.id, scope\)/.test(s), "scopes by canonical product id");
  assert.ok(/annotateTickTick\(scopedItems/.test(s), "the scoped array is what everything downstream reads");
  assert.equal(/annotateTickTick\(result\.data\.items/.test(s), false, "the unscoped array is not used");
  assert.ok(/if \(!scope\.ok\) throw/.test(s), "fails closed");
});

test("Tasks scopes its flattened task list by the canonical productId", () => {
  const s = strip(src(TASKS));
  assert.ok(/scopeRows\(result\.data\.tasks, \(t\) => t\.productId, scope\)/.test(s),
    "scopes by productId, not by SKU string");
  assert.equal(/const all = result\.data\.tasks;/.test(s), false, "the unscoped list is not used");
  assert.ok(/if \(!scope\.ok\) throw/.test(s), "fails closed");
  // Identity rule: membership is never inferred from a SKU string.
  assert.equal(/\.sku\b[^\n]*scope|scope[^\n]*\.sku\b/.test(s), false, "membership never derived from sku");
});

// ── 5 & 6. historical / global domains stay unscoped ─────────────────────────

test("historical domains are NOT master-scoped", () => {
  const ops = strip(src(OPS));
  // product_archive drives the ARCHIVED lifecycle bucket and stays a global head
  // count: archived products are historical and legitimately outside the master.
  assert.ok(/buildLifecycleBreakdown\(items, archivedCount\)/.test(ops),
    "archived count is passed through unscoped alongside the scoped items");
  assert.equal(/scopeRows\([^)]*archiv/i.test(ops), false, "the archive count is never membership-filtered");
  // Platform snapshot readers are history/presence, not current membership.
  for (const reader of ["loadShopifySnapshotView", "loadPureSoulSnapshotView", "loadTalabatSnapshotView", "loadRafeeqSnapshotView"]) {
    assert.ok(new RegExp(reader).test(ops), `${reader} still runs`);
    assert.equal(new RegExp(`scopeRows\\([^)]*${reader}`).test(ops), false, `${reader} output is not scoped`);
  }
});

test("audit, archive and staff-task history readers are untouched by this change", () => {
  // /tasks (legacy) is STAFF task management — a different reader entirely
  // (listTasks/listRoutines/listStaff), with no product membership semantics.
  const legacy = strip(src("../../app/(app)/tasks/page.tsx"));
  assert.equal(/loadMasterScope|scopeRows/.test(legacy), false, "legacy staff tasks stay global");
  for (const rel of [
    "../../app/(app)/inventory/movements/page.tsx",
    "../../app/(app)/inventory/approvals/page.tsx",
  ]) {
    assert.equal(/loadMasterScope|scopeRows/.test(strip(src(rel))), false, `${rel} stays global`);
  }
});

// ── 10. Home must not regress ────────────────────────────────────────────────

test("Home uses the SAME shared helper, with identical semantics to #700", () => {
  const s = strip(src(HOME));
  assert.ok(/scopeActionCenterView\(action, \(id\) => scope\.ids\.has\(id\), scope\.ok\)/.test(s),
    "Home routes through the shared helper");
  assert.equal(/scopeRowsKeepingGlobal/.test(s), false, "the old inline rule is gone, not duplicated");
});

test("the shared helper reproduces Home's previous keep-global behaviour exactly", () => {
  // #700's rule: keep entity-less actions, drop product-bound non-members.
  const v = view(
    input({ type: "PRICE_REVIEW", entityId: "m1" }),
    input({ type: "IMAGE_REQUIRED", entityId: "outside" }),
    input({ type: "HEALTH_ALERT", entityId: null }),
  );
  const legacyEquivalent = v.actions.filter((a) =>
    a.entityId === null || a.entityId === "" ? true : member("m1")(a.entityId));
  const viaHelper = scopeActionCenterView(v, member("m1")).actions;
  assert.deepEqual(viaHelper.map((a) => a.id), legacyEquivalent.map((a) => a.id));
  assert.deepEqual(summarizeActions(viaHelper), summarizeActions(legacyEquivalent));
});

// ── 12 & 13. no hardcoded counts, no write paths ─────────────────────────────

test("no literal master/catalog counts are used as runtime logic", () => {
  for (const rel of [OPS, TASKS, ACTIONS, HOME, "./action-scope.ts"]) {
    const s = strip(src(rel));
    for (const n of ["1343", "1530", "187", "1292"]) {
      assert.equal(new RegExp(`\\b${n}\\b`).test(s), false, `${rel} must not hardcode ${n}`);
    }
  }
});

test("no write path is introduced on the scoped surfaces", () => {
  for (const rel of [OPS, TASKS, ACTIONS, "./action-scope.ts"]) {
    const s = strip(src(rel));
    for (const [re, label] of [
      [/\.update\s*\(/, ".update("],
      [/\.insert\s*\(/, ".insert("],
      [/\.upsert\s*\(/, ".upsert("],
      [/\.delete\s*\(/, ".delete("],
    ] as const) {
      assert.equal(re.test(s), false, `${rel} must not contain ${label}`);
    }
  }
});

test("the shared scope helper is pure: no I/O, no client, no clock", () => {
  const s = strip(src("./action-scope.ts"));
  for (const [re, label] of [
    [/\bfetch\s*\(/, "fetch("],
    [/\.rpc\s*\(/, ".rpc("],
    [/createClient/, "createClient"],
    [/server-only/, "server-only"],
    [/Date\.now|new Date\(/, "a clock"],
  ] as const) {
    assert.equal(re.test(s), false, `pure module must not contain ${label}`);
  }
});
