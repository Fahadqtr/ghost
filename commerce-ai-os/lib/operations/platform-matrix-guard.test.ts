// CI.1 — safety scans for the product platform matrix (source scans).
// Guards: pure builder (no I/O), reader server-only READ-only reusing the EXISTING
// store method (no new reader/query/table), UI holds no platform logic + no client
// JS, and the product page mounts the section best-effort.
// Run: node --experimental-strip-types --test lib/operations/platform-matrix-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const PURE = readFileSync(new URL("./platform-matrix.ts", import.meta.url), "utf8");
const READ = readFileSync(new URL("./platform-matrix-read.ts", import.meta.url), "utf8");
const UI = readFileSync(new URL("../../components/v2/catalog/PlatformMatrix.tsx", import.meta.url), "utf8");
const PAGE = readFileSync(new URL("../../app/(v2)/v2/catalog/[id]/page.tsx", import.meta.url), "utf8");

test("matrix builder is PURE — no server-only, no I/O, no clock", () => {
  assert.equal(PURE.includes('import "server-only"'), false);
  for (const bad of ["fetch(", "createClient", "process.env", "Date.now(", "new Date(", ".from("]) {
    assert.equal(PURE.includes(bad), false, `pure builder must not contain ${bad}`);
  }
});

test("reader is server-only, READ-only, and adds NO new reader/query/table", () => {
  assert.ok(READ.includes('import "server-only"'));
  // reuses the EXISTING store method — never a bespoke query or a new table.
  assert.ok(READ.includes("listByProduct"), "must reuse the existing listByProduct");
  for (const bad of [".insert(", ".update(", ".delete(", ".rpc(", "createAdminClient", "service_role", "SERVICE_ROLE", "platform_snapshots", "create table"]) {
    assert.equal(READ.includes(bad), false, `reader must not contain ${bad}`);
  }
});

test("no duplicated precedence logic in the matrix layer", () => {
  // The matrix consumes already-merged state; it must not re-read live/overlay
  // readers or re-implement the snapshot→fallback precedence.
  for (const bad of ["loadShopifyPresence", "loadPureSoulPresence", "loadShopifySnapshotView", "loadTalabatSnapshotView", "loadRafeeqSnapshotView"]) {
    assert.equal(PURE.includes(bad), false, `matrix must not re-run readers (${bad})`);
    assert.equal(READ.includes(bad), false, `matrix must not re-run readers (${bad})`);
  }
});

test("UI is a Server Component with no platform logic", () => {
  assert.equal(UI.includes('"use client"'), false);
  assert.equal(UI.includes("useState"), false);
  assert.equal(UI.includes("onClick"), false);
  // No per-platform branching in the component — it renders normalized cells only.
  for (const bad of ["pure_seoul", "puresoul", "shopify", "talabat", "rafeeq", "channel_status", "classify"]) {
    assert.equal(UI.includes(bad), false, `UI must hold no platform logic (${bad})`);
  }
  assert.ok(UI.includes("حالة المنصات"), "section heading");
  assert.ok(UI.includes("—"), "untrusted fields render as —");
});

test("product page mounts the matrix best-effort (isolated)", () => {
  assert.ok(PAGE.includes("loadProductPlatformMatrix"), "page calls the reader");
  assert.ok(PAGE.includes("<PlatformMatrix"), "page renders the section");
  assert.ok(PAGE.includes("platformMatrix = null"), "reader failure is isolated");
});

test("no SQL / migration / admin / service-role in the matrix path", () => {
  for (const src of [PURE, READ]) {
    assert.equal(/create\s+table|alter\s+table|service_role|SERVICE_ROLE|createAdminClient/i.test(src), false);
  }
});
