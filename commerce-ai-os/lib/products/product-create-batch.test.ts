// Tests for createProductsBatchCore (P7/P8). PURE — stateful scripted client.
// Failures are driven by row markers: `_failProduct` fails its chunk's product
// insert; `_failInventory` fails the inventory seed for that row's chunk.
//
// Run: node --conditions=react-server --experimental-strip-types --test lib/products/product-create-batch.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { createProductsBatchCore } from "./product-create-batch.ts";

function makeClient(opts?: { deleteFail?: boolean }) {
  const products = new Map<string, Record<string, unknown>>();
  const inventory = new Map<string, Record<string, unknown>>();
  const calls: string[] = [];
  let seq = 0;
  const client = {
    from(table: string) {
      return {
        insert(values: Record<string, unknown>[]) {
          return {
            select(_c: string) {
              return {
                then<T>(onOk: (v: { data: { id: string }[] | null; error: unknown }) => T, onErr?: (e: unknown) => T) {
                  calls.push(`insert-select:${table}:${values.length}`);
                  if (values.some((v) => v._failProduct)) {
                    return Promise.resolve({ data: null, error: { message: "product chunk failed" } }).then(onOk, onErr);
                  }
                  const data = values.map((v) => {
                    const id = `p${++seq}`;
                    products.set(id, { id, ...v });
                    return { id };
                  });
                  return Promise.resolve({ data, error: null }).then(onOk, onErr);
                },
              };
            },
            then<T>(onOk: (v: { error: unknown }) => T, onErr?: (e: unknown) => T) {
              calls.push(`insert:${table}:${values.length}`);
              if (table === "inventory" && values.some((v) => products.get(String(v.product_id))?._failInventory)) {
                return Promise.resolve({ error: { message: "inv chunk failed" } }).then(onOk, onErr);
              }
              if (table === "inventory") for (const v of values) inventory.set(String(v.product_id), v);
              return Promise.resolve({ error: null }).then(onOk, onErr);
            },
          };
        },
        delete() {
          return {
            in(_col: string, ids: readonly string[]) {
              calls.push(`delete-in:${table}:${ids.length}`);
              if (opts?.deleteFail) return Promise.resolve({ error: { message: "delete failed" } });
              if (table === "products") for (const id of ids) products.delete(id);
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
  };
  return { client, products, inventory, calls };
}

const R = (name: string, extra: Record<string, unknown> = {}) => ({ sku: name, name_en: name, ...extra });

test("successful chunk creates products + inventory", async () => {
  const { client, products, inventory } = makeClient();
  const res = await createProductsBatchCore(client, [R("a"), R("b")], { seedQuantity: 0 });
  assert.deepEqual(res, { added: 2, failed: 0, failedIndexes: [], cleanup: "not_needed" });
  assert.equal(products.size, 2);
  assert.equal(inventory.size, 2);
});

test("product chunk failure marks ONLY that chunk failed; others proceed", async () => {
  const { client, products } = makeClient();
  const rows = [R("a"), R("b", { _failProduct: true }), R("c")];
  const res = await createProductsBatchCore(client, rows, { chunkSize: 1, seedQuantity: 0 });
  assert.equal(res.added, 2);
  assert.equal(res.failed, 1);
  assert.deepEqual(res.failedIndexes, [1]);
  assert.equal(res.cleanup, "not_needed", "no rollback needed — product insert wrote nothing");
  assert.deepEqual([...products.values()].map((p) => p.sku), ["a", "c"]);
});

test("inventory chunk failure rolls back ONLY that chunk; earlier stays, later runs", async () => {
  const { client, products, inventory } = makeClient();
  const rows = [R("a"), R("b", { _failInventory: true }), R("c")];
  const res = await createProductsBatchCore(client, rows, { chunkSize: 1, seedQuantity: 0 });
  assert.equal(res.added, 2, "a and c added");
  assert.equal(res.failed, 1, "b failed");
  assert.deepEqual(res.failedIndexes, [1]);
  assert.equal(res.cleanup, "done", "b's product was compensated");
  assert.deepEqual([...products.values()].map((p) => p.sku), ["a", "c"], "b rolled back, a+c remain");
  assert.equal(inventory.size, 2, "only a and c seeded");
});

test("cleanup failure is surfaced (possible orphan)", async () => {
  const { client, products } = makeClient({ deleteFail: true });
  const res = await createProductsBatchCore(client, [R("b", { _failInventory: true })], { chunkSize: 1, seedQuantity: 0 });
  assert.equal(res.failed, 1);
  assert.equal(res.added, 0);
  assert.equal(res.cleanup, "failed", "compensating delete failed → reported");
  assert.equal(products.size, 1, "the orphan remains because the delete failed (that's why cleanup=failed)");
});

test("default chunk size is 200", async () => {
  const { client, calls } = makeClient();
  const rows = Array.from({ length: 201 }, (_, i) => R(`p${i}`));
  const res = await createProductsBatchCore(client, rows, { seedQuantity: 0 });
  assert.equal(res.added, 201);
  const productInserts = calls.filter((c) => c.startsWith("insert-select:products"));
  assert.deepEqual(productInserts, ["insert-select:products:200", "insert-select:products:1"], "two chunks: 200 + 1");
});

test("custom chunk size is deterministic", async () => {
  const { client, calls } = makeClient();
  const rows = Array.from({ length: 5 }, (_, i) => R(`p${i}`));
  await createProductsBatchCore(client, rows, { chunkSize: 2, seedQuantity: 0 });
  const productInserts = calls.filter((c) => c.startsWith("insert-select:products"));
  assert.deepEqual(productInserts, ["insert-select:products:2", "insert-select:products:2", "insert-select:products:1"]);
});

test("inventorySeed output is the canonical shape; seedQuantity overrides, else per-row stock_quantity", async () => {
  // explicit seedQuantity: 0
  {
    const { client, inventory } = makeClient();
    await createProductsBatchCore(client, [R("a")], { seedQuantity: 0 });
    assert.deepEqual([...inventory.values()][0], { product_id: "p1", stock_quantity: 0, low_stock_threshold: 5, sold_quantity: 0 });
  }
  // seedQuantity override applies to all rows
  {
    const { client, inventory } = makeClient();
    await createProductsBatchCore(client, [R("a"), R("b")], { seedQuantity: 7 });
    for (const inv of inventory.values()) assert.equal(inv.stock_quantity, 7);
  }
  // no opts → per-row default row.stock_quantity ?? 0
  {
    const { client, inventory } = makeClient();
    await createProductsBatchCore(client, [R("a", { stock_quantity: 9 }), R("b")]);
    const byId = new Map([...inventory.values()].map((v) => [v.product_id, v.stock_quantity]));
    assert.equal(byId.get("p1"), 9, "row with stock_quantity seeds it");
    assert.equal(byId.get("p2"), 0, "row without stock_quantity seeds 0");
  }
});

test("inputs are not mutated", async () => {
  const { client } = makeClient();
  const rows = [R("a"), R("b")];
  const before = JSON.stringify(rows);
  await createProductsBatchCore(client, rows, { seedQuantity: 0 });
  assert.equal(JSON.stringify(rows), before, "row array/objects untouched (no stock_quantity/product_id injected)");
});

test("empty input is a no-op", async () => {
  const { client, calls } = makeClient();
  const res = await createProductsBatchCore(client, [], { seedQuantity: 0 });
  assert.deepEqual(res, { added: 0, failed: 0, failedIndexes: [], cleanup: "not_needed" });
  assert.equal(calls.length, 0);
});
