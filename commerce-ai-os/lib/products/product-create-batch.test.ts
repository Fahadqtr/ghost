// Tests for createProductsBatchCore (P7/P8 → INV.6B). PURE — stateful scripted
// client + fake service-role batch initializer. Failures are driven by row
// markers: `_failProduct` fails its chunk's product insert; `_failInventory`
// makes the injected initializer reject that chunk (as the atomic
// inv_initialize_simple_products RPC would).
//
// INV.6B contract: the batch core inserts ONLY product rows through the client;
// authoritative inventory is initialized via the injected InitializeSimpleProducts
// callback. The core performs NO direct inventory insert, so the fake client only
// ever sees a product insert-select and (on rollback) a product delete-in.
//
// Run: node --conditions=react-server --experimental-strip-types --test lib/products/product-create-batch.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { createProductsBatchCore, type InitializeSimpleProducts } from "./product-create-batch.ts";

function makeClient(opts?: { deleteFail?: boolean }) {
  const products = new Map<string, Record<string, unknown>>();
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
            // The core never does a non-select insert; capture it so a regression
            // (a direct inventory write creeping back in) is visible.
            then<T>(onOk: (v: { error: unknown }) => T, onErr?: (e: unknown) => T) {
              calls.push(`insert:${table}:${values.length}`);
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
  return { client, products, calls };
}

// Fake service-role initializer: owns the "inventory" it would create, records
// every target batch, and rejects a chunk whose product row carries _failInventory.
function makeInitializer(products: Map<string, Record<string, unknown>>) {
  const inventory = new Map<string, number>();
  const targetBatches: { productId: string; stockQuantity: number }[][] = [];
  const initializeSimple: InitializeSimpleProducts = async (targets) => {
    targetBatches.push(targets.map((t) => ({ ...t })));
    if (targets.some((t) => products.get(t.productId)?._failInventory)) return { ok: false };
    for (const t of targets) inventory.set(t.productId, t.stockQuantity);
    return { ok: true };
  };
  return { initializeSimple, inventory, targetBatches };
}

const R = (name: string, extra: Record<string, unknown> = {}) => ({ sku: name, name_en: name, ...extra });

test("successful chunk creates products + initializes inventory", async () => {
  const { client, products } = makeClient();
  const { initializeSimple, inventory } = makeInitializer(products);
  const res = await createProductsBatchCore(client, [R("a"), R("b")], initializeSimple, { seedQuantity: 0 });
  assert.deepEqual(res, { added: 2, failed: 0, failedIndexes: [], cleanup: "not_needed" });
  assert.equal(products.size, 2);
  assert.equal(inventory.size, 2);
});

test("product chunk failure marks ONLY that chunk failed; others proceed; initializer not called for it", async () => {
  const { client, products } = makeClient();
  const { initializeSimple, targetBatches } = makeInitializer(products);
  const rows = [R("a"), R("b", { _failProduct: true }), R("c")];
  const res = await createProductsBatchCore(client, rows, initializeSimple, { chunkSize: 1, seedQuantity: 0 });
  assert.equal(res.added, 2);
  assert.equal(res.failed, 1);
  assert.deepEqual(res.failedIndexes, [1]);
  assert.equal(res.cleanup, "not_needed", "no rollback needed — product insert wrote nothing");
  assert.deepEqual([...products.values()].map((p) => p.sku), ["a", "c"]);
  // Only the two successful chunks (a, c) were handed to the initializer.
  assert.equal(targetBatches.length, 2);
});

test("inventory-init chunk failure rolls back ONLY that chunk; earlier stays, later runs", async () => {
  const { client, products } = makeClient();
  const { initializeSimple, inventory } = makeInitializer(products);
  const rows = [R("a"), R("b", { _failInventory: true }), R("c")];
  const res = await createProductsBatchCore(client, rows, initializeSimple, { chunkSize: 1, seedQuantity: 0 });
  assert.equal(res.added, 2, "a and c added");
  assert.equal(res.failed, 1, "b failed");
  assert.deepEqual(res.failedIndexes, [1]);
  assert.equal(res.cleanup, "done", "b's product was compensated");
  assert.deepEqual([...products.values()].map((p) => p.sku), ["a", "c"], "b rolled back, a+c remain");
  assert.equal(inventory.size, 2, "only a and c initialized");
});

test("cleanup failure is surfaced (possible orphan)", async () => {
  const { client, products } = makeClient({ deleteFail: true });
  const { initializeSimple } = makeInitializer(products);
  const res = await createProductsBatchCore(client, [R("b", { _failInventory: true })], initializeSimple, { chunkSize: 1, seedQuantity: 0 });
  assert.equal(res.failed, 1);
  assert.equal(res.added, 0);
  assert.equal(res.cleanup, "failed", "compensating delete failed → reported");
  assert.equal(products.size, 1, "the orphan remains because the delete failed (that's why cleanup=failed)");
});

test("a malformed seed fails the whole chunk BEFORE any insert or delegation", async () => {
  for (const bad of [-1, 1.5, Number.NaN, Infinity]) {
    const { client, products, calls } = makeClient();
    const { initializeSimple, targetBatches } = makeInitializer(products);
    const res = await createProductsBatchCore(client, [R("a", { stock_quantity: bad })], initializeSimple, { chunkSize: 1 });
    assert.equal(res.added, 0);
    assert.equal(res.failed, 1);
    assert.deepEqual(res.failedIndexes, [0]);
    assert.equal(calls.length, 0, "no product insert on a malformed seed");
    assert.equal(targetBatches.length, 0, "initializer never runs on a malformed seed");
  }
});

test("default chunk size is 200", async () => {
  const { client, calls, products } = makeClient();
  const { initializeSimple } = makeInitializer(products);
  const rows = Array.from({ length: 201 }, (_, i) => R(`p${i}`));
  const res = await createProductsBatchCore(client, rows, initializeSimple, { seedQuantity: 0 });
  assert.equal(res.added, 201);
  const productInserts = calls.filter((c) => c.startsWith("insert-select:products"));
  assert.deepEqual(productInserts, ["insert-select:products:200", "insert-select:products:1"], "two chunks: 200 + 1");
});

test("custom chunk size is deterministic", async () => {
  const { client, calls, products } = makeClient();
  const { initializeSimple } = makeInitializer(products);
  const rows = Array.from({ length: 5 }, (_, i) => R(`p${i}`));
  await createProductsBatchCore(client, rows, initializeSimple, { chunkSize: 2, seedQuantity: 0 });
  const productInserts = calls.filter((c) => c.startsWith("insert-select:products"));
  assert.deepEqual(productInserts, ["insert-select:products:2", "insert-select:products:2", "insert-select:products:1"]);
});

test("initializer targets carry the right stock: seedQuantity overrides, else per-row stock_quantity", async () => {
  // explicit seedQuantity: 0
  {
    const { client, products } = makeClient();
    const { initializeSimple, targetBatches } = makeInitializer(products);
    await createProductsBatchCore(client, [R("a")], initializeSimple, { seedQuantity: 0 });
    assert.deepEqual(targetBatches[0], [{ productId: "p1", stockQuantity: 0 }]);
  }
  // seedQuantity override applies to all rows
  {
    const { client, products } = makeClient();
    const { initializeSimple, targetBatches } = makeInitializer(products);
    await createProductsBatchCore(client, [R("a"), R("b")], initializeSimple, { seedQuantity: 7 });
    for (const t of targetBatches[0]) assert.equal(t.stockQuantity, 7);
  }
  // no opts → per-row default row.stock_quantity ?? 0
  {
    const { client, products } = makeClient();
    const { initializeSimple, targetBatches } = makeInitializer(products);
    await createProductsBatchCore(client, [R("a", { stock_quantity: 9 }), R("b")], initializeSimple);
    const byId = new Map(targetBatches[0].map((t) => [t.productId, t.stockQuantity]));
    assert.equal(byId.get("p1"), 9, "row with stock_quantity seeds it");
    assert.equal(byId.get("p2"), 0, "row without stock_quantity seeds 0");
  }
});

test("inputs are not mutated; product row strips the retired stock_quantity mirror", async () => {
  const { client, products } = makeClient();
  const { initializeSimple } = makeInitializer(products);
  const rows = [R("a", { stock_quantity: 3 }), R("b")];
  const before = JSON.stringify(rows);
  await createProductsBatchCore(client, rows, initializeSimple, { seedQuantity: 0 });
  assert.equal(JSON.stringify(rows), before, "row array/objects untouched");
  for (const p of products.values()) assert.ok(!("stock_quantity" in p), "inserted product row has no stock_quantity mirror");
});

test("empty input is a no-op", async () => {
  const { client, calls, products } = makeClient();
  const { initializeSimple, targetBatches } = makeInitializer(products);
  const res = await createProductsBatchCore(client, [], initializeSimple, { seedQuantity: 0 });
  assert.deepEqual(res, { added: 0, failed: 0, failedIndexes: [], cleanup: "not_needed" });
  assert.equal(calls.length, 0);
  assert.equal(targetBatches.length, 0);
});
