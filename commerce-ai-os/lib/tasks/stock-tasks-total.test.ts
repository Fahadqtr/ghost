// INV.6A — totalStock canonical-total tests (DB-free, fake admin client).
// The old totalStock summed parent inventory + variant rows, double-counting a
// valid variant product (parent inventory IS the Σ-variants rollup). The fix:
//   VARIANT product → total = Σ variants (parent ignored);
//   SIMPLE product  → total = inventory.stock_quantity.
//
// Run: node --conditions=react-server --experimental-strip-types --test lib/tasks/stock-tasks-total.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { totalStock } from "./total-stock.ts";

// Fake admin: from(table).select(cols).eq(col,val) → { data }. `tables` supplies
// the rows returned per table (any eq filter returns them — one product per test).
function fakeAdmin(tables: Record<string, { stock_quantity: number | null }[]>) {
  return {
    from(table: string) {
      return {
        select(_cols: string) {
          return {
            eq(_col: string, _val: string) {
              return Promise.resolve({ data: tables[table] ?? [], error: null });
            },
          };
        },
      };
    },
  } as any;
}

test("SIMPLE product: total = inventory.stock_quantity", async () => {
  const admin = fakeAdmin({ product_variants: [], inventory: [{ stock_quantity: 5 }] });
  assert.equal(await totalStock(admin, "p1"), 5);
});

test("VARIANT product: total = Σ variants, NOT parent + variants", async () => {
  // parent inventory says 5 (the rollup) and variants are 2 + 3 → total 5, never 10.
  const admin = fakeAdmin({ inventory: [{ stock_quantity: 5 }], product_variants: [{ stock_quantity: 2 }, { stock_quantity: 3 }] });
  assert.equal(await totalStock(admin, "p1"), 5);
});

test("VARIANT product: Σ variants wins even if the parent inventory row drifts", async () => {
  const admin = fakeAdmin({ inventory: [{ stock_quantity: 99 }], product_variants: [{ stock_quantity: 2 }, { stock_quantity: 3 }] });
  assert.equal(await totalStock(admin, "p1"), 5);
});

test("no inventory and no variants → 0", async () => {
  const admin = fakeAdmin({ product_variants: [], inventory: [] });
  assert.equal(await totalStock(admin, "p1"), 0);
});
