// Tests for the Shopify order → inventory deduction planner (INV.5 grain-aware).
// Run: node --experimental-strip-types --test lib/shopify/order-deduct-compute.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import {
  planOrderDeductions, spreadDeduction, isVoidOrder,
  type OrderForDeduction, type CatalogRowLite, type VariantRowLite,
} from "./order-deduct-compute.ts";

// p1 = simple; p2 = simple (no sku, title only); p3 = variant product (2 variants).
const CATALOG: CatalogRowLite[] = [
  { id: "p1", sku: "MK-1", name_en: "Rose Serum" },
  { id: "p2", sku: null, name_en: "Gold – Mask" },
  { id: "p3", sku: "PARENT-3", name_en: "Lip Set" },
];
const VARIANTS: VariantRowLite[] = [
  { id: "v3a", parent_product_id: "p3", sku: "LIP-RED", variant_name: "Red" },
  { id: "v3b", parent_product_id: "p3", sku: "LIP-PINK", variant_name: "Pink" },
];

const order = (over: Partial<OrderForDeduction>): OrderForDeduction => ({
  id: "gid://1", name: "#1001", financial: "PAID", cancelledAt: null,
  items: [{ title: "Rose Serum", qty: 1, sku: "mk-1" }],
  ...over,
});
const plan = (orders: OrderForDeduction[], seen = new Set<string>()) =>
  planOrderDeductions(orders, CATALOG, VARIANTS, seen);

// ── simple grain ──────────────────────────────────────────────────────────────

test("exact simple SKU → simple target; title fallback for a unique simple; aggregates", () => {
  const p = plan([
    order({}),
    order({ id: "gid://2", items: [{ title: "Whatever", qty: 2, sku: "MK-1" }, { title: "Gold Mask", qty: 1 }] }),
    order({ id: "gid://3", items: [{ title: "Unknown Thing", qty: 4 }] }),
  ]);
  assert.deepEqual(p.orderIds, ["gid://1", "gid://2", "gid://3"]);
  assert.deepEqual(p.deductions.sort((a, b) => a.productId.localeCompare(b.productId)), [
    { productId: "p1", variantId: null, name_en: "Rose Serum", qty: 3 },
    { productId: "p2", variantId: null, name_en: "Gold – Mask", qty: 1 },
  ]);
  assert.deepEqual(p.unmatched, [{ title: "Unknown Thing", qty: 4 }]);
});

// ── variant grain ─────────────────────────────────────────────────────────────

test("exact UNIQUE variant SKU → variant target (parent inventory never targeted)", () => {
  const p = plan([order({ id: "gid://v", items: [{ title: "Lip Set", qty: 2, sku: "LIP-RED" }] })]);
  assert.deepEqual(p.deductions, [{ productId: "p3", variantId: "v3a", name_en: "Red", qty: 2 }]);
  assert.deepEqual(p.unmatched, []);
});

test("parent SKU on a variant product → BLOCK (never deduct the parent grain)", () => {
  const p = plan([order({ id: "gid://x", items: [{ title: "Lip Set", qty: 1, sku: "PARENT-3" }] })]);
  assert.deepEqual(p.deductions, []);
  assert.deepEqual(p.unmatched, [{ title: "Lip Set", qty: 1 }]);
});

test("title matching a variant PARENT → BLOCK (no title-only deduction on a variant product)", () => {
  const p = plan([order({ id: "gid://x", items: [{ title: "Lip Set", qty: 1 }] })]);
  assert.deepEqual(p.deductions, []);
  assert.deepEqual(p.unmatched, [{ title: "Lip Set", qty: 1 }]);
});

test("duplicate variant SKU across products → ambiguous → BLOCK", () => {
  const dupVariants: VariantRowLite[] = [
    { id: "v3a", parent_product_id: "p3", sku: "DUP", variant_name: "Red" },
    { id: "v9a", parent_product_id: "p9", sku: "DUP", variant_name: "Other" },
  ];
  const p = planOrderDeductions(
    [order({ id: "gid://x", items: [{ title: "x", qty: 1, sku: "DUP" }] })],
    CATALOG, dupVariants, new Set(),
  );
  assert.deepEqual(p.deductions, []);
  assert.deepEqual(p.unmatched, [{ title: "x", qty: 1 }]);
});

test("duplicate simple title → BLOCK", () => {
  const dupCatalog: CatalogRowLite[] = [
    { id: "a", sku: null, name_en: "Same Name" },
    { id: "b", sku: null, name_en: "Same Name" },
  ];
  const p = planOrderDeductions(
    [order({ id: "gid://x", items: [{ title: "Same Name", qty: 1 }] })],
    dupCatalog, [], new Set(),
  );
  assert.deepEqual(p.deductions, []);
  assert.deepEqual(p.unmatched, [{ title: "Same Name", qty: 1 }]);
});

test("variant SKU priority beats a simple SKU collision", () => {
  // a simple product and a variant share the normalized SKU → variant wins (unique variant)
  const cat: CatalogRowLite[] = [{ id: "ps", sku: "SHARED", name_en: "Simple" }];
  const vars: VariantRowLite[] = [{ id: "vv", parent_product_id: "pv", sku: "SHARED", variant_name: "V" }];
  const p = planOrderDeductions([order({ id: "gid://x", items: [{ title: "x", qty: 1, sku: "SHARED" }] })], cat, vars, new Set());
  assert.deepEqual(p.deductions, [{ productId: "pv", variantId: "vv", name_en: "V", qty: 1 }]);
});

// ── ledger / channel plumbing (unchanged behavior) ────────────────────────────

test("already-synced orders are skipped entirely", () => {
  const p = plan([order({})], new Set(["gid://1"]));
  assert.deepEqual(p.orderIds, []);
  assert.deepEqual(p.deductions, []);
});

test("cancelled/refunded orders are recorded but never deduct", () => {
  assert.equal(isVoidOrder({ financial: "REFUNDED", cancelledAt: null }), true);
  assert.equal(isVoidOrder({ financial: "PAID", cancelledAt: "2026-01-01" }), true);
  assert.equal(isVoidOrder({ financial: "PAID", cancelledAt: null }), false);
  const p = plan([order({ financial: "REFUNDED" })]);
  assert.deepEqual(p.orderIds, ["gid://1"]);
  assert.deepEqual(p.deductions, []);
});

test("payment gateway names are carried through `considered` without affecting deductions", () => {
  const p = plan([
    order({ id: "gid://1", paymentGatewayNames: ["Talabat"] }),
    order({ id: "gid://2", items: [{ title: "Rose Serum", qty: 2, sku: "MK-1" }], paymentGatewayNames: ["Cash"] }),
  ]);
  assert.deepEqual(p.considered.map((c) => c.id), ["gid://1", "gid://2"]);
  assert.deepEqual(p.considered.find((c) => c.id === "gid://1")?.paymentGatewayNames, ["Talabat"]);
  assert.deepEqual(p.deductions, [{ productId: "p1", variantId: null, name_en: "Rose Serum", qty: 3 }]);
});

test("a repeated (already-synced) order id is never re-considered or re-deducted", () => {
  const p = plan([order({ paymentGatewayNames: ["Talabat"] })], new Set(["gid://1"]));
  assert.deepEqual(p.orderIds, []);
  assert.deepEqual(p.considered, []);
  assert.deepEqual(p.deductions, []);
});

test("missing paymentGatewayNames defaults to an empty array in `considered`", () => {
  const p = plan([order({})]);
  assert.deepEqual(p.considered[0].paymentGatewayNames, []);
});

// ── spreadDeduction remains a pure util (SQL now owns the real spread) ─────────

test("spreadDeduction drains biggest rows first and clamps at zero", () => {
  const updates = spreadDeduction([{ rowKey: "a", stock: 2 }, { rowKey: "b", stock: 5 }], 6);
  assert.deepEqual(updates, [{ rowKey: "b", stock: 0 }, { rowKey: "a", stock: 1 }]);
  assert.deepEqual(spreadDeduction([{ rowKey: "a", stock: 1 }], 9), [{ rowKey: "a", stock: 0 }]);
  assert.deepEqual(spreadDeduction([], 3), []);
});
