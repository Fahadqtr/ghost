// Tests for the scheduled availability sync core.
// Run: node --experimental-strip-types --test lib/availability-sync.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import {
  projectAvailability,
  planStatusUpserts,
  statusKey,
  type ProductAvailabilityRow,
  type ProductStatus,
} from "./availability-sync.ts";

// ---- projectAvailability (explicit stock_status → overlay) ------------------

test("In Stock projects to InStock", () => {
  const rows: ProductAvailabilityRow[] = [{ id: "p1", stock_status: "In Stock" }];
  assert.deepEqual(projectAvailability(rows), [{ product_id: "p1", availability: "InStock" }]);
});

test("Out of Stock projects to OutOfStock", () => {
  const rows: ProductAvailabilityRow[] = [{ id: "p1", stock_status: "Out of Stock" }];
  assert.deepEqual(projectAvailability(rows), [{ product_id: "p1", availability: "OutOfStock" }]);
});

test("unknown / null / legacy values project to OutOfStock (never a quantity guess)", () => {
  for (const v of ["Low Stock", "", "  ", null, "instock", "whatever"]) {
    const rows: ProductAvailabilityRow[] = [{ id: "p1", stock_status: v as string | null }];
    assert.equal(projectAvailability(rows)[0].availability, "OutOfStock", `${JSON.stringify(v)} → OutOfStock`);
  }
});

test("rows without an id are ignored; duplicate ids collapse to the first", () => {
  const rows: ProductAvailabilityRow[] = [
    { id: null, stock_status: "In Stock" },
    { id: "p1", stock_status: "In Stock" },
    { id: "p1", stock_status: "Out of Stock" }, // duplicate — first wins
  ];
  assert.deepEqual(projectAvailability(rows), [{ product_id: "p1", availability: "InStock" }]);
});

test("projection is deterministic (same input → equal output)", () => {
  const rows: ProductAvailabilityRow[] = [
    { id: "p1", stock_status: "In Stock" },
    { id: "p2", stock_status: "Out of Stock" },
  ];
  assert.deepEqual(projectAvailability(rows), projectAvailability(rows));
});

// ---- planStatusUpserts -----------------------------------------------------

const NOW = "2026-07-02T00:00:00.000Z";
const OVERLAY = ["pure_seoul", "talabat", "shopify", "rafeeq"] as const;

test("emits one upsert per overlay platform for a fresh product", () => {
  const statuses: ProductStatus[] = [{ product_id: "p1", availability: "OutOfStock" }];
  const { upserts, counts } = planStatusUpserts(statuses, OVERLAY, new Map(), NOW);
  assert.equal(upserts.length, OVERLAY.length);
  assert.ok(upserts.every((u) => u.availability === "OutOfStock" && u.updated_at === NOW));
  assert.deepEqual(counts, { products: 1, out: 1, inStock: 0 });
});

test("writes nothing when current already matches desired (idempotent)", () => {
  const statuses: ProductStatus[] = [{ product_id: "p1", availability: "InStock" }];
  const current = new Map<string, string>();
  for (const p of OVERLAY) current.set(statusKey("p1", p), "InStock");
  const { upserts, counts } = planStatusUpserts(statuses, OVERLAY, current, NOW);
  assert.equal(upserts.length, 0);
  assert.deepEqual(counts, { products: 1, out: 0, inStock: 1 });
});

test("emits only the platforms whose current state differs", () => {
  const statuses: ProductStatus[] = [{ product_id: "p1", availability: "OutOfStock" }];
  const current = new Map<string, string>([
    [statusKey("p1", "pure_seoul"), "OutOfStock"], // already correct → skip
    [statusKey("p1", "talabat"), "InStock"],       // stale → flip
    // shopify, rafeeq unset → emit
  ]);
  const { upserts } = planStatusUpserts(statuses, OVERLAY, current, NOW);
  const platforms = upserts.map((u) => u.platform).sort();
  assert.deepEqual(platforms, ["rafeeq", "shopify", "talabat"]);
  assert.ok(upserts.every((u) => u.availability === "OutOfStock"));
});

test("counts reflect the full desired state, not just the diff", () => {
  const statuses: ProductStatus[] = [
    { product_id: "p1", availability: "OutOfStock" },
    { product_id: "p2", availability: "InStock" },
    { product_id: "p3", availability: "OutOfStock" },
  ];
  const { counts } = planStatusUpserts(statuses, OVERLAY, new Map(), NOW);
  assert.deepEqual(counts, { products: 3, out: 2, inStock: 1 });
});
