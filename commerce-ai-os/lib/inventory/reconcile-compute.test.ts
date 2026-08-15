// Production-Reconciliation — pure reconciliation math tests. DB-free.
// Run: node --conditions=react-server --experimental-strip-types --test lib/inventory/reconcile-compute.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { reconcileProduct, classifyRepairs, primaryShelfLocation, type ReconcileInput } from "./reconcile-compute.ts";

function input(over: Partial<ReconcileInput>): ReconcileInput {
  return {
    productId: over.productId ?? "p1",
    inventoryRows: over.inventoryRows ?? [],
    variants: over.variants ?? [],
    shelfStock: over.shelfStock ?? [],
    variantShelfStock: over.variantShelfStock ?? [],
  };
}
const codes = (r: { issues: { code: string }[] }) => r.issues.map((i) => i.code).sort();

// ── exactly-one-inventory invariant ───────────────────────────────────────────

test("zero inventory rows → inconsistent missing_inventory_row (never sum([])=0 clean)", () => {
  const r = reconcileProduct(input({ inventoryRows: [] }));
  assert.equal(r.status, "inconsistent");
  assert.deepEqual(codes(r), ["missing_inventory_row"]);
  assert.equal(r.current.parentStock, null);
});

test("two inventory rows → inconsistent duplicate_inventory_rows", () => {
  const r = reconcileProduct(input({ inventoryRows: [{ stock_quantity: 3 }, { stock_quantity: 4 }] }));
  assert.equal(r.status, "inconsistent");
  assert.deepEqual(codes(r), ["duplicate_inventory_rows"]);
  assert.equal(r.current.parentStock, null);
});

// ── simple ─────────────────────────────────────────────────────────────────────

test("simple clean (no shelves, null location)", () => {
  const r = reconcileProduct(input({ inventoryRows: [{ stock_quantity: 5, location: null }] }));
  assert.equal(r.status, "clean");
  assert.equal(r.kind, "simple");
  assert.deepEqual(r.current, { parentStock: 5, variantSum: null, shelfSum: null, location: null });
  assert.deepEqual(r.issues, []);
});

test("simple shelf clean (Σ shelves == inventory, location == primary)", () => {
  const r = reconcileProduct(input({
    inventoryRows: [{ stock_quantity: 7, location: "A1" }],
    shelfStock: [{ id: "s1", location: "A1", quantity: 4 }, { id: "s2", location: "B2", quantity: 3 }],
  }));
  assert.equal(r.status, "clean");
  assert.equal(r.current.shelfSum, 7);
  assert.deepEqual(r.issues, []);
});

test("simple shelf + correct primary is clean; wrong primary → primary_location_drift", () => {
  const wrong = reconcileProduct(input({
    inventoryRows: [{ stock_quantity: 7, location: "B2" }], // primary should be A1 (qty 4 > 3)
    shelfStock: [{ id: "s1", location: "A1", quantity: 4 }, { id: "s2", location: "B2", quantity: 3 }],
  }));
  assert.equal(wrong.status, "drift");
  assert.deepEqual(codes(wrong), ["primary_location_drift"]);
  assert.equal(wrong.expected.location, "A1");
});

test("simple shelf drift (Σ shelves ≠ inventory)", () => {
  const r = reconcileProduct(input({
    inventoryRows: [{ stock_quantity: 1, location: "A1" }],
    shelfStock: [{ id: "s1", location: "A1", quantity: 50 }],
  }));
  assert.equal(r.status, "drift");
  assert.deepEqual(codes(r), ["shelf_drift"]);
  assert.equal(r.issues[0].got, 50);
  assert.equal(r.issues[0].want, 1);
});

test("simple no shelf + location set → stale_location_without_shelf (drift)", () => {
  const r = reconcileProduct(input({ inventoryRows: [{ stock_quantity: 5, location: "A2" }] }));
  assert.equal(r.status, "drift");
  assert.deepEqual(codes(r), ["stale_location_without_shelf"]);
  assert.equal(r.expected.location, null);
});

test("simple malformed inventory / shelf / sold → inconsistent", () => {
  assert.equal(reconcileProduct(input({ inventoryRows: [{ stock_quantity: null }] })).status, "inconsistent");
  assert.equal(reconcileProduct(input({ inventoryRows: [{ stock_quantity: 5, location: "A1" }], shelfStock: [{ id: "s", location: "A1", quantity: -2 }] })).status, "inconsistent");
  const sold = reconcileProduct(input({ inventoryRows: [{ stock_quantity: 5, sold_quantity: -1, location: null }] }));
  assert.equal(sold.status, "inconsistent");
  assert.ok(codes(sold).includes("malformed_sold_quantity"));
  // sold undefined (not provided) is not flagged
  assert.equal(reconcileProduct(input({ inventoryRows: [{ stock_quantity: 5, location: null }] })).status, "clean");
});

// ── variant parent rollup ──────────────────────────────────────────────────────

test("variant parent rollup clean (inventory == Σ variants, parent location null)", () => {
  const r = reconcileProduct(input({
    inventoryRows: [{ stock_quantity: 9, location: null }],
    variants: [{ id: "v1", stock_quantity: 4 }, { id: "v2", stock_quantity: 5 }],
  }));
  assert.equal(r.status, "clean");
  assert.equal(r.kind, "variant");
  assert.equal(r.expected.parentStock, 9);
  assert.deepEqual(r.issues, []);
});

test("variant parent rollup drift", () => {
  const r = reconcileProduct(input({
    inventoryRows: [{ stock_quantity: 1, location: null }],
    variants: [{ id: "v1", stock_quantity: 12 }, { id: "v2", stock_quantity: 13 }, { id: "v3", stock_quantity: 16 }],
  }));
  assert.equal(r.status, "drift");
  assert.deepEqual(codes(r), ["parent_rollup_drift"]);
  assert.equal(r.expected.parentStock, 41);
});

test("variant parent with product-level shelf rows → inconsistent even if sums match", () => {
  const r = reconcileProduct(input({
    inventoryRows: [{ stock_quantity: 9, location: "A1" }],
    variants: [{ id: "v1", stock_quantity: 9 }],
    shelfStock: [{ id: "s1", location: "A1", quantity: 9 }], // sums match, still illegal
  }));
  assert.equal(r.status, "inconsistent");
  assert.ok(codes(r).includes("parent_has_shelf_rows"));
});

test("variant parent with nonnull location → stale_location_without_shelf (drift)", () => {
  const r = reconcileProduct(input({
    inventoryRows: [{ stock_quantity: 9, location: "A2" }],
    variants: [{ id: "v1", stock_quantity: 9 }],
  }));
  assert.equal(r.status, "drift");
  assert.deepEqual(codes(r), ["stale_location_without_shelf"]);
  assert.equal(r.expected.location, null);
});

test("NULL / negative / fractional variant quantity → inconsistent", () => {
  for (const q of [null, -1, 1.5] as const) {
    const r = reconcileProduct(input({ inventoryRows: [{ stock_quantity: 3, location: null }], variants: [{ id: "v1", stock_quantity: q }] }));
    assert.equal(r.status, "inconsistent");
    assert.ok(codes(r).includes("malformed_variant_quantity"));
  }
});

// ── variant shelves ────────────────────────────────────────────────────────────

test("variant shelf clean / drift / malformed", () => {
  const clean = reconcileProduct(input({
    inventoryRows: [{ stock_quantity: 10, location: null }],
    variants: [{ id: "v1", stock_quantity: 6 }, { id: "v2", stock_quantity: 4 }],
    variantShelfStock: [{ id: "x1", variant_id: "v1", location: "A1", quantity: 6 }, { id: "x2", variant_id: "v2", location: "A2", quantity: 4 }],
  }));
  assert.equal(clean.status, "clean");

  const drift = reconcileProduct(input({
    inventoryRows: [{ stock_quantity: 16, location: null }],
    variants: [{ id: "v1", stock_quantity: 16 }],
    variantShelfStock: [{ id: "x1", variant_id: "v1", location: "A1", quantity: 10 }],
  }));
  assert.equal(drift.status, "drift");
  assert.deepEqual(codes(drift), ["variant_shelf_drift"]);
  assert.equal(drift.issues[0].want, 16);

  const mal = reconcileProduct(input({
    inventoryRows: [{ stock_quantity: 5, location: null }],
    variants: [{ id: "v1", stock_quantity: 5 }],
    variantShelfStock: [{ id: "x1", variant_id: "v1", location: "A1", quantity: 2.5 }],
  }));
  assert.equal(mal.status, "inconsistent");
});

// ── precedence + primary helper ────────────────────────────────────────────────

test("inconsistent beats drift (precedence)", () => {
  const r = reconcileProduct(input({
    inventoryRows: [{ stock_quantity: 2, location: null }],
    variants: [{ id: "v1", stock_quantity: null }],
    shelfStock: [{ id: "s", location: "A1", quantity: 99 }],
  }));
  assert.equal(r.status, "inconsistent");
});

test("primaryShelfLocation: max qty, tie → location ASC, then id ASC", () => {
  assert.equal(primaryShelfLocation([{ id: "1", location: "B", quantity: 3 }, { id: "2", location: "A", quantity: 5 }]), "A");
  assert.equal(primaryShelfLocation([{ id: "9", location: "B", quantity: 5 }, { id: "8", location: "A", quantity: 5 }]), "A");
  assert.equal(primaryShelfLocation([]), null);
});

// ── repair classification ──────────────────────────────────────────────────────

test("classifyRepairs: single-shelf drifts + rollup + stale-location are AUTO_SAFE", () => {
  const simpleShelf = input({ inventoryRows: [{ id: "i", stock_quantity: 1, location: "A1" }], shelfStock: [{ id: "s1", location: "A1", quantity: 50 }] });
  assert.equal(classifyRepairs(reconcileProduct(simpleShelf), simpleShelf).find((x) => x.code === "shelf_drift")?.repair, "AUTO_SAFE");

  const rollup = input({ inventoryRows: [{ id: "i", stock_quantity: 1, location: null }], variants: [{ id: "v1", stock_quantity: 41 }] });
  assert.equal(classifyRepairs(reconcileProduct(rollup), rollup).find((x) => x.code === "parent_rollup_drift")?.repair, "AUTO_SAFE");

  const stale = input({ inventoryRows: [{ id: "i", stock_quantity: 5, location: "A2" }] });
  assert.equal(classifyRepairs(reconcileProduct(stale), stale).find((x) => x.code === "stale_location_without_shelf")?.repair, "AUTO_SAFE");

  const vshelf = input({ inventoryRows: [{ id: "i", stock_quantity: 13, location: null }], variants: [{ id: "v1", stock_quantity: 13 }], variantShelfStock: [{ id: "x", variant_id: "v1", location: "A5", quantity: 10 }] });
  assert.equal(classifyRepairs(reconcileProduct(vshelf), vshelf).find((x) => x.code === "variant_shelf_drift")?.repair, "AUTO_SAFE");
});

test("classifyRepairs: multi-shelf drift + malformed + missing/duplicate + parent_has_shelf are MANUAL_REQUIRED", () => {
  const multi = input({ inventoryRows: [{ id: "i", stock_quantity: 5, location: "A1" }], shelfStock: [{ id: "s1", location: "A1", quantity: 3 }, { id: "s2", location: "B2", quantity: 3 }] });
  assert.equal(classifyRepairs(reconcileProduct(multi), multi).find((x) => x.code === "shelf_drift")?.repair, "MANUAL_REQUIRED");

  const nullVar = input({ inventoryRows: [{ id: "i", stock_quantity: 1, location: null }], variants: [{ id: "v1", stock_quantity: null }] });
  const cls = classifyRepairs(reconcileProduct(nullVar), nullVar);
  assert.ok(cls.every((x) => x.repair === "MANUAL_REQUIRED"));

  const dup = input({ inventoryRows: [{ stock_quantity: 1 }, { stock_quantity: 2 }] });
  assert.equal(classifyRepairs(reconcileProduct(dup), dup)[0].repair, "MANUAL_REQUIRED");
});
