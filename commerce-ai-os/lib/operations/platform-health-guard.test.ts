// CI.4 — safety scans for platform freshness & health (source scans).
// Guards: the model module is PURE (no I/O / no new reader / no query / no hidden
// clock — `now` is injected), it invents NO new absolute threshold (reuses the
// existing per-platform windows), the score stays null (no numeric 0–100 / false
// precision), the page builds it from already-loaded data (zero new reads) without
// touching the CI.2 queue, and the UI holds NO platform branching and NO client JS.
// Run: node --conditions=react-server --experimental-strip-types --test lib/operations/platform-health-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const PURE = readFileSync(new URL("./platform-health.ts", import.meta.url), "utf8");
const UI = readFileSync(new URL("../../components/v2/operations/PlatformHealth.tsx", import.meta.url), "utf8");
const PAGE = readFileSync(new URL("../../app/(v2)/v2/operations/page.tsx", import.meta.url), "utf8");
const DASH = readFileSync(new URL("../../components/v2/operations/OperationsDashboard.tsx", import.meta.url), "utf8");

test("model module is PURE — no I/O / no DB / no hidden clock", () => {
  assert.equal(PURE.includes('import "server-only"'), false);
  for (const bad of ["fetch(", "createClient", "process.env", "Date.now(", "new Date(", ".from(", ".rpc(", ".insert(", ".update("]) {
    assert.equal(PURE.includes(bad), false, `pure module must not contain ${bad}`);
  }
  // `now` is injected as an argument, never read from a hidden clock.
  assert.ok(/now:\s*number/.test(PURE), "the builder takes `now` as an argument");
  assert.ok(PURE.includes("Date.parse("), "freshness parses the injected timestamp deterministically");
});

test("no new reader / query / snapshot in the health path", () => {
  for (const bad of [
    "loadOperations",
    "loadShopify",
    "loadPureSoul",
    "loadTalabat",
    "loadRafeeq",
    "platform_snapshots",
    "SupabaseSnapshotStore",
    "snapshot-presence",
    "read-model",
    "-read",
  ]) {
    assert.equal(PURE.includes(bad), false, `health model must add no reads (${bad})`);
  }
});

test("no new absolute threshold — reuses the EXISTING per-platform stale windows", () => {
  for (const c of [
    "PURESOUL_SNAPSHOT_STALE_MS",
    "SHOPIFY_SNAPSHOT_STALE_MS",
    "TALABAT_SNAPSHOT_STALE_MS",
    "RAFEEQ_SNAPSHOT_STALE_MS",
  ]) {
    assert.ok(PURE.includes(c), `must reuse the existing window constant ${c}`);
  }
  // The only new constant is the aging FRACTION of the existing window (0.5) — a
  // derived early-warning band, not a new absolute hour/day threshold.
  assert.ok(/AGING_FRACTION\s*=\s*0\.5/.test(PURE), "aging is a fraction of the existing window");
  assert.equal(/=\s*\d+\s*\*\s*60\s*\*\s*60\s*\*\s*1000/.test(PURE), false, "no new hand-rolled ms window");
});

test("score stays null — no numeric 0–100 / no false precision", () => {
  assert.ok(/healthScore:\s*null/.test(PURE), "healthScore is null in CI.4 v1");
  // No score arithmetic: the module never computes a numeric score.
  assert.equal(PURE.includes("healthScore = "), false, "healthScore is never assigned a computed value");
  assert.equal(/score\s*[-+*/]=|\*\s*100|\/\s*100/.test(PURE), false, "no 0–100 score math");
  // The UI never renders a numeric score either.
  assert.equal(UI.includes("healthScore"), false, "UI must not render a numeric score");
});

test("honesty invariants are encoded (unknown ≠ missing; stale/degraded never missing)", () => {
  // unknownCount is not part of the attention triggers.
  assert.equal(/unknownCount\s*>\s*0/.test(PURE), false, "unknownCount is never an attention trigger");
  // degraded / unavailable resolves to insufficient_data, never missing.
  assert.ok(PURE.includes('"degraded_read"'), "degraded is its own reason");
  assert.ok(PURE.includes('"insufficient_data"'), "degraded/empty read => insufficient_data");
});

test("no SQL / migration / admin / service-role anywhere in the health path", () => {
  for (const src of [PURE, UI, PAGE, DASH]) {
    assert.equal(/create\s+table|alter\s+table|migration|service_role|SERVICE_ROLE|createAdminClient|\.rpc\(/i.test(src), false);
  }
});

test("page builds health from already-loaded data (zero new reads) + injects now", () => {
  assert.ok(PAGE.includes("buildPlatformHealth"), "page builds the health model");
  assert.ok(/summary\.platformOverview/.test(PAGE), "built from the already-computed overview");
  assert.ok(/summary\.kpis\.totalProducts/.test(PAGE), "coverage total comes from the already-computed KPIs");
  assert.ok(/buildPlatformHealth\([\s\S]*new Date\(\)\.getTime\(\)/.test(PAGE), "now is injected at the call site");
  // no extra loader added for health
  assert.equal(PAGE.includes("loadPlatformHealth") || PAGE.includes("platform-health-read"), false, "health adds no reader");
});

test("page does NOT change the CI.2 unified queue or the existing summary", () => {
  // additive only — the existing pipeline is untouched.
  assert.ok(PAGE.includes("buildDashboardSummary"), "summary still built");
  assert.ok(PAGE.includes("buildOperationsQueues"), "CI.2 queue still built");
});

test("dashboard renders the health strip ABOVE the platform overview (additive)", () => {
  assert.ok(DASH.includes("PlatformHealthSection"), "dashboard renders the health section");
  assert.ok(DASH.includes("PlatformOverviewSection"), "existing overview section unchanged");
  const health = DASH.indexOf("<PlatformHealthSection");
  const overview = DASH.indexOf("<PlatformOverviewSection");
  assert.ok(health > -1 && overview > -1 && health < overview, "health strip renders above the overview grid");
});

test("UI holds NO platform branching + NO client JS", () => {
  assert.equal(UI.includes('"use client"'), false);
  assert.equal(UI.includes("useState"), false);
  assert.equal(UI.includes("onClick"), false);
  // no branching on platform name / no platform-specific business logic
  for (const bad of ["puresoul", "talabat", "rafeeq", '"shopify"', "classifyPureSoul", "classifyShopify", "priceDifferent", "outOfStock"]) {
    assert.equal(UI.includes(bad), false, `UI must not branch on platform internals (${bad})`);
  }
  // all labels/tones come from the lib maps
  assert.ok(/HEALTH_LEVEL_LABELS|HEALTH_LEVEL_TONE|FRESHNESS_LABELS/.test(UI), "UI reads labels/tones from lib maps");
  assert.ok(UI.includes("صحة المنصات وحداثة البيانات"), "section heading present");
  assert.ok(UI.includes("بيانات غير كافية"), "insufficient-data message present");
});
