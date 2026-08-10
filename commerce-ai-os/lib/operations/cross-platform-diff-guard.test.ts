// CI.3 — safety scans for the cross-platform diff (source scans).
// Guards: pure module (no I/O / no new reader / no query / no clock / no platform
// branching), the diff compares Platform-vs-Malikas ONLY (no platform-vs-platform),
// the page builds it from already-loaded data (zero new reads) and does not touch
// the CI.2 unified queue, the UI holds no comparison logic + no client JS, and the
// existing matrix builders are unchanged (additive `title` only).
// Run: node --conditions=react-server --experimental-strip-types --test lib/operations/cross-platform-diff-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const PURE = readFileSync(new URL("./cross-platform-diff.ts", import.meta.url), "utf8");
const MATRIX = readFileSync(new URL("./platform-matrix.ts", import.meta.url), "utf8");
const PAGE = readFileSync(new URL("../../app/(v2)/v2/catalog/[id]/page.tsx", import.meta.url), "utf8");
const UI = readFileSync(new URL("../../components/v2/catalog/PlatformMatrix.tsx", import.meta.url), "utf8");

test("diff module is PURE — no I/O / no DB / no clock", () => {
  assert.equal(PURE.includes('import "server-only"'), false);
  for (const bad of ["fetch(", "createClient", "process.env", "Date.now(", "new Date(", ".from(", ".rpc(", ".insert(", ".update("]) {
    assert.equal(PURE.includes(bad), false, `pure module must not contain ${bad}`);
  }
});

test("no new reader / query / snapshot in the diff path", () => {
  for (const bad of ["listByProduct", "listLatestByPlatform", "platform_snapshots", "SupabaseSnapshotStore", "loadProduct", "loadCatalogProduct", "read-model", "-read"]) {
    assert.equal(PURE.includes(bad), false, `diff must add no reads (${bad})`);
  }
});

test("diff never branches on platform internals — it consumes normalized cells only", () => {
  for (const bad of ["puresoulState", "talabatState", "rafeeqState", "shopifyStatus", "classifyPureSoul", "classifyShopify", "classifyTalabat", "classifyRafeeq", "pure_seoul", "channel_status", "SnapshotView"]) {
    assert.equal(PURE.includes(bad), false, `diff must not branch on platform internals (${bad})`);
  }
  assert.ok(PURE.includes("PlatformMatrixCell"), "diff consumes the normalized matrix cell");
});

test("comparison is Platform-vs-Malikas ONLY — never platform-vs-platform", () => {
  // The classifier compares exactly two named sides: a Malikas source value and a
  // single platform value. It must never take two platform cells.
  assert.ok(/classifyFieldDiff\(\s*sourceValue/.test(PURE), "classify takes a source (Malikas) value");
  assert.equal(/classifyFieldDiff\([^)]*cellA|cellB|otherCell|platformA|platformB/.test(PURE), false, "no platform-vs-platform comparison");
  // buildCrossPlatformDiff takes ONE product + the cells; it iterates cells once.
  assert.ok(/buildCrossPlatformDiff\(\s*\n?\s*product/.test(PURE), "diff is built per product (source of truth) vs cells");
});

test("identity (externalId) is never compared as a value field", () => {
  // Only price + title are comparable value fields.
  assert.ok(PURE.includes('"price"') && PURE.includes('"title"'), "value fields are price + title");
  assert.equal(/DiffField\s*=\s*"price"\s*\|\s*"title"/.test(PURE), true, "DiffField is exactly price|title");
  assert.equal(PURE.includes('field: "externalId"') || PURE.includes('"externalId"'), false, "externalId is not a diff field");
});

test("no SQL / migration / admin / service-role anywhere in the diff path", () => {
  for (const src of [PURE, PAGE, UI]) {
    assert.equal(/create\s+table|alter\s+table|migration|service_role|SERVICE_ROLE|createAdminClient|\.rpc\(/i.test(src), false);
  }
});

test("page builds the diff from already-loaded data (zero new reads)", () => {
  assert.ok(PAGE.includes("buildCrossPlatformDiff"), "page builds the diff");
  // built from the product record already loaded + the matrix cells already loaded
  assert.ok(/platformMatrix\.cells/.test(PAGE), "diff is built from the already-loaded matrix cells");
  assert.ok(/state\.product/.test(PAGE), "diff source is the already-loaded product record");
  // no extra loader added for the diff
  assert.equal(PAGE.includes("loadCrossPlatformDiff") || PAGE.includes("cross-platform-diff-read"), false, "diff adds no reader");
});

test("page does NOT change the CI.2 unified operations queue", () => {
  for (const bad of ["buildOperationsQueues", "paginateIssues", "parseQueueControl"]) {
    assert.equal(PAGE.includes(bad), false, `product page must not touch the queue (${bad})`);
  }
});

test("UI holds no comparison logic + no client JS; uses native <details>", () => {
  assert.equal(UI.includes('"use client"'), false);
  assert.equal(UI.includes("useState"), false);
  assert.equal(UI.includes("onClick"), false);
  // comparison decided in the pure module — the UI must not recompute equality
  assert.equal(/sourceValue\s*===|platformValue\s*===|\.toLowerCase\(\)\s*===/.test(UI), false, "UI must not compare values");
  assert.ok(UI.includes("<details"), "expandable uses native <details> (no client JS)");
  assert.ok(UI.includes("الفروقات مقابل ماليكاس"), "detail heading present");
});

test("matrix builders unchanged behaviour — `title` added additively (trust-gated)", () => {
  // The two public builders keep their names + signatures.
  assert.ok(MATRIX.includes("export function buildPlatformMatrixItem"), "state-only builder intact");
  assert.ok(MATRIX.includes("export function buildProductPlatformMatrix"), "rich builder intact");
  // title is trust-gated (PureSoul only) exactly like the other value fields.
  assert.ok(/title:\s*trust\.title\s*\?\s*S\(snapshot\.title\)\s*:\s*null/.test(MATRIX), "rich title is trust-gated");
  assert.ok(/title:\s*null/.test(MATRIX), "state-only cell nulls title");
});
