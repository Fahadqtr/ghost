// Tests for the Talabat stock-snapshot loader. Fake Supabase client only —
// NO real Supabase, NO network.
// Run: node --conditions=react-server --experimental-strip-types --test lib/talabat/stock-snapshots.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { loadStockSnapshots } from "./stock-snapshots.ts";

// Chainable fake: from(table).select(...).eq(col,val)[.eq(col,val)] → {data,error}.
function makeAdmin(tables: Record<string, any>) {
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const b: any = {
        select() { return b; },
        eq(col: string, val: unknown) { filters[col] = val; return b; },
        then(resolve: (v: any) => void, reject: (e: any) => void) {
          try {
            const src = tables[table];
            if (typeof src === "function") return resolve(src(filters));
            let rows: any[] = Array.isArray(src) ? src : [];
            for (const [k, v] of Object.entries(filters)) rows = rows.filter((r) => r[k] === v);
            resolve({ data: rows, error: null });
          } catch (e) { reject(e); }
        },
      };
      return b;
    },
  };
}

test("a no-variant target loads inventory + shelf_stock rows", async () => {
  const admin = makeAdmin({
    inventory: [{ id: "inv1", product_id: "p1", stock_quantity: 7 }],
    shelf_stock: [{ inventory_id: "inv1", location: "A", quantity: 4 }, { inventory_id: "inv1", location: "B", quantity: 3 }],
  });
  const res = await loadStockSnapshots(admin, [{ masterProductId: "p1", masterVariantSku: null }]);
  assert.equal(res.status, "ok");
  if (res.status === "ok") {
    assert.equal(res.snapshots.length, 1);
    const s = res.snapshots[0] as any;
    assert.equal(s.kind, "product");
    assert.equal(s.inventoryId, "inv1");
    assert.equal(s.inventoryStock, 7);
    assert.equal(s.shelves.length, 2);
  }
});

test("a variant target loads the exact variant + variant_shelf_stock rows", async () => {
  const admin = makeAdmin({
    product_variants: [{ id: "v1", parent_product_id: "p2", sku: "V-SKU", stock_quantity: 10 }],
    variant_shelf_stock: [{ variant_id: "v1", location: "A", quantity: 10 }],
  });
  const res = await loadStockSnapshots(admin, [{ masterProductId: "p2", masterVariantSku: "V-SKU" }]);
  assert.equal(res.status, "ok");
  if (res.status === "ok") {
    const s = res.snapshots[0] as any;
    assert.equal(s.kind, "variant");
    assert.equal(s.variantId, "v1");
    assert.equal(s.masterVariantSku, "V-SKU");
    assert.equal(s.variantStock, 10);
    assert.equal(s.shelves[0].location, "A");
  }
});

test("duplicate inventory rows are passed THROUGH (never hidden) for the planner to reject", async () => {
  const admin = makeAdmin({
    inventory: [{ id: "invA", product_id: "p1", stock_quantity: 5 }, { id: "invB", product_id: "p1", stock_quantity: 9 }],
    shelf_stock: [],
  });
  const res = await loadStockSnapshots(admin, [{ masterProductId: "p1", masterVariantSku: null }]);
  assert.equal(res.status, "ok");
  if (res.status === "ok") assert.equal(res.snapshots.length, 2); // both duplicates surfaced
});

test("NULL / negative stock values are passed through unchanged (never coerced to 0)", async () => {
  const admin = makeAdmin({
    product_variants: [{ id: "v1", parent_product_id: "p2", sku: "V-SKU", stock_quantity: null }],
    variant_shelf_stock: [{ variant_id: "v1", location: "A", quantity: -3 }],
  });
  const res = await loadStockSnapshots(admin, [{ masterProductId: "p2", masterVariantSku: "V-SKU" }]);
  assert.equal(res.status, "ok");
  if (res.status === "ok") {
    const s = res.snapshots[0] as any;
    assert.equal(s.variantStock, null);         // not 0
    assert.equal(s.shelves[0].quantity, -3);    // not 0
  }
});

test("any query error → status error (caller maps to inventory_inconsistent)", async () => {
  const admin = makeAdmin({
    inventory: () => ({ data: null, error: { message: "boom" } }),
    shelf_stock: [],
  });
  const res = await loadStockSnapshots(admin, [{ masterProductId: "p1", masterVariantSku: null }]);
  assert.deepEqual(res, { status: "error" });
});
