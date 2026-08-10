// CI.2 — safety scans for the unified operations queue (source scans).
// Guards: pure module (no I/O / no new reader / no platform branching), UI holds
// no platform logic + no client JS, page wires it from existing items (no new
// reads), and existing operations filters remain intact.
// Run: node --experimental-strip-types --test lib/operations/operations-queue-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const PURE = readFileSync(new URL("./operations-queue.ts", import.meta.url), "utf8");
const PAGE = readFileSync(new URL("../../app/(v2)/v2/operations/page.tsx", import.meta.url), "utf8");
const DASH = readFileSync(new URL("../../components/v2/operations/OperationsDashboard.tsx", import.meta.url), "utf8");

test("queue module is PURE — no I/O / no DB / no clock", () => {
  assert.equal(PURE.includes('import "server-only"'), false);
  for (const bad of ["fetch(", "createClient", "process.env", "Date.now(", "new Date(", ".from(", ".rpc(", ".insert(", ".update("]) {
    assert.equal(PURE.includes(bad), false, `pure module must not contain ${bad}`);
  }
});

test("queue derives from MatrixState only — no per-platform branching", () => {
  // Severity/reason/queue come from buildPlatformMatrixItem's MatrixState. The
  // module must not re-read platform enums or re-run any reader.
  for (const bad of ["puresoulState", "talabatState", "rafeeqState", "shopifyStatus", "pure_seoul", "channel_status", "classify", "loadShopifyPresence", "SnapshotView"]) {
    assert.equal(PURE.includes(bad), false, `queue must not branch on platform internals (${bad})`);
  }
  assert.ok(PURE.includes("buildPlatformMatrixItem"), "must build from the matrix");
});

test("no new reader / query / snapshot in the queue path", () => {
  for (const bad of ["listByProduct", "listLatestByPlatform", "platform_snapshots", "SupabaseSnapshotStore", "loadProduct"]) {
    assert.equal(PURE.includes(bad), false, `queue must add no reads (${bad})`);
  }
});

test("page builds the queue from the already-loaded items (zero new reads)", () => {
  assert.ok(PAGE.includes("buildOperationsQueues"), "page builds queues");
  assert.ok(PAGE.includes("parseQueueControl") && PAGE.includes("paginateIssues"), "page parses + paginates the queue");
  // built from `items` — the same array feeding the dashboard summary.
  assert.ok(/buildOperationsQueues\(items\)/.test(PAGE), "queue must be built from the existing items array");
});

test("existing operations controls/filters remain intact", () => {
  // The queue uses its OWN params (queue/qpage) — it must not replace the product
  // list controls or its pipeline.
  assert.ok(PAGE.includes("parseOperationsControls"), "product-list controls still parsed");
  assert.ok(PAGE.includes("selectOperationsPage"), "product-list pipeline still used");
});

test("UI section holds no platform business logic + no client JS", () => {
  assert.equal(DASH.includes('"use client"'), false);
  assert.equal(DASH.includes("useState"), false);
  assert.equal(DASH.includes("onClick"), false);
  // The unified queue section renders labels only — no platform enum branching.
  assert.ok(DASH.includes("UnifiedQueueSection"), "section present");
  assert.ok(DASH.includes("قائمة المشاكل الموحدة"), "section heading");
});

test("no SQL / migration / admin / service-role anywhere in the queue path", () => {
  for (const src of [PURE, PAGE]) {
    assert.equal(/create\s+table|alter\s+table|service_role|SERVICE_ROLE|createAdminClient|\.rpc\(/i.test(src), false);
  }
});
