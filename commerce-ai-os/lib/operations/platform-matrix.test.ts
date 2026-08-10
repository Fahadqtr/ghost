// CI.1 — Product Platform Matrix (PURE) tests.
// Run: node --experimental-strip-types --test lib/operations/platform-matrix.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPlatformMatrixItem,
  buildProductPlatformMatrix,
  type PlatformMatrixItem,
} from "./platform-matrix.ts";
import type { OperationsListItem } from "./dashboard-view.ts";
import { createSnapshot } from "../platforms/core/snapshot.ts";
import type { PlatformSnapshot, SnapshotInput } from "../platforms/core/types.ts";

const AT = "2026-08-10T10:00:00.000Z";
const NOW = Date.parse("2026-08-10T12:00:00.000Z");

function snap(input: Partial<SnapshotInput> & { platform: string }): PlatformSnapshot {
  return createSnapshot({ capturedAt: AT, productId: "p1", ...input } as SnapshotInput);
}
function cellOf(m: PlatformMatrixItem, platform: string) {
  return m.cells.find((c) => c.platform === platform)!;
}

// ── builder 2: rich product-page matrix from full snapshots ──────────────────

test("PureSoul published → present; trusted externalId/price/availability shown", () => {
  const s = snap({ platform: "pure_seoul", externalId: "PS1", price: 12, availability: "InStock", status: "Approved", metadata: { ps: { verdict: "present" } } });
  const m = buildProductPlatformMatrix("p1", "SKU", "BC", [s], NOW);
  const c = cellOf(m, "puresoul");
  assert.equal(c.state, "present");
  assert.equal(c.externalId, "PS1");
  assert.equal(c.price, 12);
  assert.equal(c.availability, "InStock");
  assert.equal(c.source, "snapshot");
});

test("PureSoul price_different → different (+flag)", () => {
  const s = snap({ platform: "pure_seoul", price: 9, availability: "InStock", status: "Approved", metadata: { ps: { verdict: "present", priceDiff: true } } });
  const c = cellOf(buildProductPlatformMatrix("p1", null, null, [s], NOW), "puresoul");
  assert.equal(c.state, "different");
  assert.ok(c.flags.includes("price_different"));
});

test("PureSoul out_of_stock → present with out_of_stock flag (never missing)", () => {
  const s = snap({ platform: "pure_seoul", availability: "OutOfStock", status: "Approved", metadata: { ps: { verdict: "present" } } });
  const c = cellOf(buildProductPlatformMatrix("p1", null, null, [s], NOW), "puresoul");
  assert.equal(c.state, "present");
  assert.ok(c.flags.includes("out_of_stock"));
});

test("Shopify live → present; externalId trusted, price/availability render as — (null)", () => {
  const s = snap({ platform: "shopify", externalId: "gid://1", status: "active", price: 50, availability: "InStock", metadata: { shopify: { linked: true, live: true, reviewRequired: false, presence: "present" } } });
  const c = cellOf(buildProductPlatformMatrix("p1", null, null, [s], NOW), "shopify");
  assert.equal(c.state, "present");
  assert.equal(c.externalId, "gid://1");
  assert.equal(c.price, null, "Shopify price is untrusted → —");
  assert.equal(c.availability, null, "Shopify availability is untrusted → —");
});

test("Shopify linked-only (draft) → ready", () => {
  const s = snap({ platform: "shopify", externalId: "gid://2", status: "draft", metadata: { shopify: { linked: true, live: false, reviewRequired: false, presence: "present" } } });
  assert.equal(cellOf(buildProductPlatformMatrix("p1", null, null, [s], NOW), "shopify").state, "ready");
});

test("Talabat missing → missing; Talabat linked → ready; all fields —", () => {
  const miss = snap({ platform: "talabat", status: "missing", metadata: { talabat: { verdict: "missing" } } });
  const cm = cellOf(buildProductPlatformMatrix("p1", null, null, [miss], NOW), "talabat");
  assert.equal(cm.state, "missing");
  assert.equal(cm.externalId, null);
  assert.equal(cm.price, null);
  assert.equal(cm.availability, null);
});

test("Rafeeq Active/present → present; Rafeeq Draft/id-only → ready; externalId trusted", () => {
  const present = snap({ platform: "rafeeq", externalId: "R1", status: "Active", metadata: { rafeeq: { verdict: "present" } } });
  const cp = cellOf(buildProductPlatformMatrix("p1", null, null, [present], NOW), "rafeeq");
  assert.equal(cp.state, "present");
  assert.equal(cp.externalId, "R1");
  assert.equal(cp.price, null);

  const linked = snap({ platform: "rafeeq", externalId: "R2", status: "Draft", metadata: { rafeeq: { verdict: "linked" } } });
  assert.equal(cellOf(buildProductPlatformMatrix("p1", null, null, [linked], NOW), "rafeeq").state, "ready");
});

test("absent platform → unknown (never missing); stale never becomes missing", () => {
  const m = buildProductPlatformMatrix("p1", null, null, [], NOW);
  for (const c of m.cells) {
    assert.equal(c.state, "unknown");
    assert.equal(c.source, "unknown");
  }
  // an old present snapshot is stale but still present, NOT missing
  const old = snap({ platform: "rafeeq", externalId: "R", status: "Active", capturedAt: "2026-01-01T00:00:00.000Z", metadata: { rafeeq: { verdict: "present" } } });
  const c = cellOf(buildProductPlatformMatrix("p1", null, null, [old], NOW), "rafeeq");
  assert.equal(c.state, "present");
  assert.equal(c.stale, true);
});

test("newest snapshot per platform wins; deterministic PLATFORM order", () => {
  const older = snap({ platform: "rafeeq", status: "Active", capturedAt: "2026-08-01T00:00:00.000Z", metadata: { rafeeq: { verdict: "present" } } });
  const newer = snap({ platform: "rafeeq", status: "Not Listed", capturedAt: "2026-08-09T00:00:00.000Z", metadata: { rafeeq: { verdict: "missing" } } });
  const m = buildProductPlatformMatrix("p1", null, null, [older, newer], NOW);
  assert.equal(cellOf(m, "rafeeq").state, "missing"); // newest wins
  assert.deepEqual(m.cells.map((c) => c.platform), ["shopify", "puresoul", "talabat", "rafeeq"]);
});

test("issueCount / needsAttention count missing+different+review only", () => {
  const m = buildProductPlatformMatrix("p1", null, null, [
    snap({ platform: "talabat", status: "missing", metadata: { talabat: { verdict: "missing" } } }), // issue
    snap({ platform: "pure_seoul", price: 1, availability: "InStock", status: "Approved", metadata: { ps: { verdict: "present", priceDiff: true } } }), // different → issue
    snap({ platform: "shopify", externalId: "g", status: "active", metadata: { shopify: { linked: true, live: true } } }), // present → no issue
    // rafeeq absent → unknown → no issue
  ], NOW);
  assert.equal(m.issueCount, 2);
  assert.equal(m.needsAttention, true);
});

// ── builder 1: all-products / operations (state-only) ────────────────────────

function item(over: Partial<OperationsListItem>): OperationsListItem {
  return {
    id: "p1", sku: "SKU", barcode: "BC", platforms: [], tasks: [],
    ...over,
  } as OperationsListItem;
}

test("buildPlatformMatrixItem: maps merged operations states; fields stay — (null)", () => {
  const m = buildPlatformMatrixItem(item({
    platforms: [{ platform: "shopify", status: "published", label: "" }],
    puresoulState: "missing",
    talabatState: "linked",
    rafeeqState: "present",
  }));
  assert.equal(cellOf(m, "shopify").state, "present");
  assert.equal(cellOf(m, "puresoul").state, "missing");
  assert.equal(cellOf(m, "talabat").state, "ready");
  assert.equal(cellOf(m, "rafeeq").state, "present");
  // state-only path exposes no raw fields
  for (const c of m.cells) {
    assert.equal(c.externalId, null);
    assert.equal(c.price, null);
    assert.equal(c.availability, null);
  }
  assert.equal(m.issueCount, 1); // puresoul missing
});

test("buildPlatformMatrixItem: no states → all unknown, no attention", () => {
  const m = buildPlatformMatrixItem(item({}));
  for (const c of m.cells) assert.equal(c.state, "unknown");
  assert.equal(m.needsAttention, false);
  assert.equal(m.productId, "p1");
});

test("product scoping: item identity carried through", () => {
  const m = buildProductPlatformMatrix("prod-42", "S42", "B42", [], NOW);
  assert.equal(m.productId, "prod-42");
  assert.equal(m.sku, "S42");
  assert.equal(m.barcode, "B42");
});
