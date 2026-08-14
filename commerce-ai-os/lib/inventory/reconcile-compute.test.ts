// INV.3B — pure reconciliation math tests. DB-free.
// Run: node --conditions=react-server --experimental-strip-types --test lib/inventory/reconcile-compute.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { reconcileProduct, type ReconcileInput } from "./reconcile-compute.ts";

// Minimal input builder — every list defaults to empty.
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

// ── simple ────────────────────────────────────────────────────────────────────

test("simple clean (no shelves)", () => {
  const r = reconcileProduct(input({ inventoryRows: [{ stock_quantity: 5 }] }));
  assert.equal(r.status, "clean");
  assert.equal(r.kind, "simple");
  assert.deepEqual(r.current, { parentStock: 5, variantSum: null, shelfSum: null });
  assert.equal(r.expected.parentStock, 5);
  assert.deepEqual(r.issues, []);
});

test("simple shelf clean (Σ shelves == inventory)", () => {
  const r = reconcileProduct(input({
    inventoryRows: [{ stock_quantity: 7 }],
    shelfStock: [{ location: "A1", quantity: 4 }, { location: "B2", quantity: 3 }],
  }));
  assert.equal(r.status, "clean");
  assert.equal(r.current.shelfSum, 7);
  assert.deepEqual(r.issues, []);
});

test("simple shelf drift (Σ shelves ≠ inventory)", () => {
  const r = reconcileProduct(input({
    inventoryRows: [{ stock_quantity: 1 }],
    shelfStock: [{ location: "A1", quantity: 50 }],
  }));
  assert.equal(r.status, "drift");
  assert.deepEqual(codes(r), ["shelf_drift"]);
  const issue = r.issues[0];
  assert.equal(issue.got, 50);
  assert.equal(issue.want, 1);
});

test("simple with malformed inventory quantity → inconsistent", () => {
  const r = reconcileProduct(input({ inventoryRows: [{ stock_quantity: null }] }));
  assert.equal(r.status, "inconsistent");
  assert.deepEqual(codes(r), ["malformed_inventory_quantity"]);
  assert.equal(r.current.parentStock, null);
});

test("simple malformed shelf quantity → inconsistent", () => {
  const r = reconcileProduct(input({
    inventoryRows: [{ stock_quantity: 5 }],
    shelfStock: [{ location: "A1", quantity: -2 }],
  }));
  assert.equal(r.status, "inconsistent");
  assert.deepEqual(codes(r), ["malformed_shelf_quantity"]);
});

// ── variant: parent rollup ──────────────────────────────────────────────────────

test("variant parent rollup clean (inventory == Σ variants)", () => {
  const r = reconcileProduct(input({
    inventoryRows: [{ stock_quantity: 9 }],
    variants: [{ id: "v1", stock_quantity: 4 }, { id: "v2", stock_quantity: 5 }],
  }));
  assert.equal(r.status, "clean");
  assert.equal(r.kind, "variant");
  assert.equal(r.current.parentStock, 9);
  assert.equal(r.current.variantSum, 9);
  assert.equal(r.expected.parentStock, 9);
  assert.deepEqual(r.issues, []);
});

test("variant parent rollup drift (inventory ≠ Σ variants)", () => {
  const r = reconcileProduct(input({
    inventoryRows: [{ stock_quantity: 1 }],
    variants: [{ id: "v1", stock_quantity: 12 }, { id: "v2", stock_quantity: 13 }, { id: "v3", stock_quantity: 16 }],
  }));
  assert.equal(r.status, "drift");
  assert.deepEqual(codes(r), ["parent_rollup_drift"]);
  assert.equal(r.expected.parentStock, 41);
  assert.equal(r.current.parentStock, 1);
  assert.equal(r.issues[0].got, 1);
  assert.equal(r.issues[0].want, 41);
});

test("multiple variants sum correctly", () => {
  const r = reconcileProduct(input({
    inventoryRows: [{ stock_quantity: 10 }],
    variants: [
      { id: "v1", stock_quantity: 1 },
      { id: "v2", stock_quantity: 2 },
      { id: "v3", stock_quantity: 3 },
      { id: "v4", stock_quantity: 4 },
    ],
  }));
  assert.equal(r.status, "clean");
  assert.equal(r.current.variantSum, 10);
});

test("NULL variant quantity → inconsistent (fail-closed)", () => {
  const r = reconcileProduct(input({
    inventoryRows: [{ stock_quantity: 3 }],
    variants: [{ id: "v1", stock_quantity: 3 }, { id: "v2", stock_quantity: null }],
  }));
  assert.equal(r.status, "inconsistent");
  assert.ok(codes(r).includes("malformed_variant_quantity"));
  assert.equal(r.current.variantSum, null);
  assert.equal(r.expected.parentStock, null);
});

test("negative variant quantity → inconsistent", () => {
  const r = reconcileProduct(input({
    inventoryRows: [{ stock_quantity: 3 }],
    variants: [{ id: "v1", stock_quantity: -1 }],
  }));
  assert.equal(r.status, "inconsistent");
  assert.ok(codes(r).includes("malformed_variant_quantity"));
});

test("fractional variant quantity → inconsistent", () => {
  const r = reconcileProduct(input({
    inventoryRows: [{ stock_quantity: 3 }],
    variants: [{ id: "v1", stock_quantity: 1.5 }],
  }));
  assert.equal(r.status, "inconsistent");
  assert.ok(codes(r).includes("malformed_variant_quantity"));
});

// ── variant: shelves ─────────────────────────────────────────────────────────

test("variant shelf clean (Σ variant shelves == variant stock)", () => {
  const r = reconcileProduct(input({
    inventoryRows: [{ stock_quantity: 10 }],
    variants: [{ id: "v1", stock_quantity: 6 }, { id: "v2", stock_quantity: 4 }],
    variantShelfStock: [
      { variant_id: "v1", location: "A1", quantity: 6 },
      { variant_id: "v2", location: "A2", quantity: 4 },
    ],
  }));
  assert.equal(r.status, "clean");
  assert.deepEqual(r.issues, []);
});

test("variant shelf drift (Σ variant shelves ≠ variant stock)", () => {
  const r = reconcileProduct(input({
    inventoryRows: [{ stock_quantity: 16 }],
    variants: [{ id: "v1", stock_quantity: 16 }],
    variantShelfStock: [{ variant_id: "v1", location: "A1", quantity: 10 }],
  }));
  assert.equal(r.status, "drift");
  assert.deepEqual(codes(r), ["variant_shelf_drift"]);
  assert.equal(r.issues[0].variantId, "v1");
  assert.equal(r.issues[0].got, 10);
  assert.equal(r.issues[0].want, 16);
});

test("malformed variant shelf quantity → inconsistent", () => {
  const r = reconcileProduct(input({
    inventoryRows: [{ stock_quantity: 5 }],
    variants: [{ id: "v1", stock_quantity: 5 }],
    variantShelfStock: [{ variant_id: "v1", location: "A1", quantity: 2.5 }],
  }));
  assert.equal(r.status, "inconsistent");
  assert.ok(codes(r).includes("malformed_variant_shelf_quantity"));
});

// ── edges ────────────────────────────────────────────────────────────────────

test("no shelves is not a drift (overlay simply absent)", () => {
  const r = reconcileProduct(input({
    inventoryRows: [{ stock_quantity: 8 }],
    variants: [{ id: "v1", stock_quantity: 8 }],
  }));
  assert.equal(r.status, "clean");
  assert.equal(r.current.shelfSum, null);
});

test("zero quantities are clean (simple and variant)", () => {
  const simple = reconcileProduct(input({ inventoryRows: [{ stock_quantity: 0 }] }));
  assert.equal(simple.status, "clean");
  const variant = reconcileProduct(input({
    inventoryRows: [{ stock_quantity: 0 }],
    variants: [{ id: "v1", stock_quantity: 0 }, { id: "v2", stock_quantity: 0 }],
  }));
  assert.equal(variant.status, "clean");
  assert.equal(variant.expected.parentStock, 0);
});

test("drift + inconsistency together resolve to inconsistent (precedence)", () => {
  const r = reconcileProduct(input({
    inventoryRows: [{ stock_quantity: 2 }],
    variants: [{ id: "v1", stock_quantity: null }],       // malformed → inconsistent
    shelfStock: [{ location: "A1", quantity: 99 }],       // would-be shelf drift
  }));
  assert.equal(r.status, "inconsistent");
});
