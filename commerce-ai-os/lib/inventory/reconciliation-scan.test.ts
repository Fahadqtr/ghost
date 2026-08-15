// Production-Reconciliation — global scanner tests (DB-free, fake client).
// Run: node --conditions=react-server --experimental-strip-types --test lib/inventory/reconciliation-scan.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { scanReconciliation } from "./reconciliation-scan.ts";

// A fake Supabase client over in-memory tables. Supports the exact chains the
// scanner uses: products select→order→range; others select→in; orphan child
// select→range, parent select→in. `failTable` forces a read error.
function makeClient(tables: Record<string, any[]>, failTable?: string) {
  function rows(t: string) { return tables[t] ?? []; }
  return {
    from(table: string) {
      return {
        select(_cols: string) {
          const api: any = {
            order() { return api; },
            range(a: number, b: number) {
              if (table === failTable) return Promise.resolve({ data: null, error: { message: "boom" } });
              return Promise.resolve({ data: rows(table).slice(a, b + 1), error: null });
            },
            in(col: string, ids: string[]) {
              if (table === failTable) return Promise.resolve({ data: null, error: { message: "boom" } });
              const set = new Set(ids);
              return Promise.resolve({ data: rows(table).filter((r) => set.has(r[col])), error: null });
            },
          };
          return api;
        },
      };
    },
  };
}

const EMPTY = { inventory: [], product_variants: [], shelf_stock: [], variant_shelf_stock: [] };

test("scans all products across pages; aggregates clean/drift/inconsistent + issue counts", async () => {
  const tables = {
    products: [{ id: "p1" }, { id: "p2" }, { id: "p3" }, { id: "p4" }],
    inventory: [
      { id: "i1", product_id: "p1", stock_quantity: 5, sold_quantity: 0, location: null },        // clean simple
      { id: "i2", product_id: "p2", stock_quantity: 1, sold_quantity: 0, location: "A1" },         // simple shelf drift
      { id: "i3", product_id: "p3", stock_quantity: 1, sold_quantity: 0, location: null },         // variant rollup drift
      { id: "i4a", product_id: "p4", stock_quantity: 3, sold_quantity: 0, location: null },        // duplicate inventory
      { id: "i4b", product_id: "p4", stock_quantity: 4, sold_quantity: 0, location: null },
    ],
    product_variants: [{ id: "v3", parent_product_id: "p3", stock_quantity: 41 }],
    shelf_stock: [{ id: "s2", inventory_id: "i2", location: "A1", quantity: 50 }],
    variant_shelf_stock: [],
  };
  const r = await scanReconciliation(makeClient(tables) as any, { pageSize: 2 }); // forces 2 pages
  assert.equal(r.complete, true);
  assert.equal(r.productsTotal, 4);
  assert.equal(r.cleanProducts, 1);            // p1
  assert.equal(r.driftProducts, 2);            // p2, p3
  assert.equal(r.inconsistentProducts, 1);     // p4
  assert.equal(r.issueCounts["shelf_drift"], 1);
  assert.equal(r.issueCounts["primary_location_drift"], undefined); // p2 location IS the primary (A1)
  assert.equal(r.issueCounts["parent_rollup_drift"], 1);
  assert.equal(r.issueCounts["duplicate_inventory_rows"], 1);
  assert.equal(r.orphanShelfStock, 0);
  assert.equal(r.orphanVariantShelfStock, 0);
});

test("a product with overlapping issues counts once as a dirty product", async () => {
  // p1: variant rollup drift AND a stale parent location → two issues, ONE dirty product.
  const tables = {
    products: [{ id: "p1" }],
    inventory: [{ id: "i1", product_id: "p1", stock_quantity: 1, sold_quantity: 0, location: "A2" }],
    product_variants: [{ id: "v1", parent_product_id: "p1", stock_quantity: 5 }],
    shelf_stock: [],
    variant_shelf_stock: [],
  };
  const r = await scanReconciliation(makeClient(tables) as any, { pageSize: 50 });
  assert.equal(r.driftProducts, 1);
  assert.equal(r.cleanProducts, 0);
  assert.equal(r.issueCounts["parent_rollup_drift"], 1);
  assert.equal(r.issueCounts["stale_location_without_shelf"], 1);
});

test("global orphan checks: shelf row pointing at a missing inventory / variant", async () => {
  const tables = {
    products: [{ id: "p1" }],
    inventory: [{ id: "i1", product_id: "p1", stock_quantity: 5, sold_quantity: 0, location: "A1" }],
    product_variants: [],
    shelf_stock: [
      { id: "s1", inventory_id: "i1", location: "A1", quantity: 5 },
      { id: "s2", inventory_id: "iX", location: "B1", quantity: 2 }, // orphan
    ],
    variant_shelf_stock: [{ id: "x1", variant_id: "vX", location: "C1", quantity: 1 }], // orphan
  };
  const r = await scanReconciliation(makeClient(tables) as any, { pageSize: 50 });
  assert.equal(r.orphanShelfStock, 1);
  assert.equal(r.orphanVariantShelfStock, 1);
});

test("a read failure makes the scan INCOMPLETE (never claims zero drift)", async () => {
  const tables = { products: [{ id: "p1" }], ...EMPTY };
  const r = await scanReconciliation(makeClient(tables, "inventory") as any, { pageSize: 50 });
  assert.equal(r.complete, false);
  assert.ok(r.error);
});

test("empty catalog → complete, zero everything", async () => {
  const r = await scanReconciliation(makeClient({ products: [], ...EMPTY }) as any, { pageSize: 50 });
  assert.equal(r.complete, true);
  assert.equal(r.productsTotal, 0);
  assert.equal(r.driftProducts + r.inconsistentProducts, 0);
});
