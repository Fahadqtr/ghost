// Tests for createProductCore (Phase UI.5 → INV.6B). PURE — scripted fake client
// + fake service-role initializer. Run:
// node --conditions=react-server --experimental-strip-types --test lib/products/product-create.test.ts
//
// INV.6B contract: the core inserts ONLY the product row through the client; all
// authoritative numeric/structural state (inventory + variants) is delegated to
// the injected InitializeInventoryState callback (backed, in production, by the
// atomic service-role inv_initialize_product_state RPC). The core performs NO
// direct inventory/product_variants write, so the fake client only ever sees a
// product insert-select and (on rollback) a product delete.

import test from "node:test";
import assert from "node:assert/strict";

import {
  createProductCore,
  projectVariantInsertRows,
  type CreateVariantRow,
  type InitializeInventoryState,
} from "./product-create.ts";

interface Call {
  kind: string;
  table?: string;
  values?: unknown;
  column?: string;
  value?: string;
}

function makeClient(over: Record<string, unknown> = {}) {
  const o = {
    productInsert: { data: { id: "p-new" } as Record<string, unknown> | null, error: null as { code?: string; message: string } | null },
    deleteError: null as unknown,
    ...over,
  };
  const calls: Call[] = [];
  const client = {
    from(table: string) {
      return {
        insert(values: Record<string, unknown> | Record<string, unknown>[]) {
          return {
            select(_c: string) {
              return {
                single() {
                  calls.push({ kind: "insert-select", table, values });
                  return Promise.resolve(o.productInsert);
                },
              };
            },
            // The core never does a non-single insert; capture it so a regression
            // (a direct inventory/variant write creeping back in) is visible.
            then<T>(onOk: (v: { error: unknown }) => T, onErr?: (e: unknown) => T) {
              calls.push({ kind: "insert", table, values });
              return Promise.resolve({ error: null }).then(onOk, onErr);
            },
          };
        },
        delete() {
          return {
            filter(column: string, _op: string, value: string) {
              calls.push({ kind: "delete", table, column, value });
              return Promise.resolve({ error: o.deleteError });
            },
          };
        },
      };
    },
  };
  return { client, calls };
}

type InitArg = { productId: string; simpleStock: number; variants: readonly CreateVariantRow[] };

function makeInit(
  result: { ok: true } | { ok: false; reason: string; duplicateIdentity?: boolean } = { ok: true },
) {
  const initCalls: InitArg[] = [];
  const initialize: InitializeInventoryState = async (args) => {
    initCalls.push({ productId: args.productId, simpleStock: args.simpleStock, variants: args.variants });
    return result;
  };
  return { initialize, initCalls };
}

const ROW = { sku: "mk9", name_ar: "سيروم", stock_quantity: 7 };
const VROWS: CreateVariantRow[] = [
  { variant_name: "وردي", variant_name_en: "Pink", sku: "mk9-1", barcode: "4006381333948", color: null, size: null, price: 10, stock_quantity: 1 },
];

test("happy path: product inserted, structural state delegated to the initializer", async () => {
  const { client, calls } = makeClient();
  const { initialize, initCalls } = makeInit();
  const res = await createProductCore(client, ROW, VROWS, initialize);
  assert.deepEqual(res, { ok: true, productId: "p-new" });

  // Only the product row is written through the client — no inventory/variant insert.
  assert.deepEqual(calls.map((c) => `${c.kind}:${c.table}`), ["insert-select:products"]);

  // The initializer receives the new product id + the normalized variant rows.
  assert.equal(initCalls.length, 1);
  assert.equal(initCalls[0].productId, "p-new");
  assert.equal(initCalls[0].simpleStock, 0, "variant product: simpleStock is not the authority");
  assert.equal(initCalls[0].variants.length, 1);
  assert.equal(initCalls[0].variants[0].sku, "mk9-1");
  assert.equal(initCalls[0].variants[0].stock_quantity, 1);
});

test("no variants -> initializer called with an empty variants array, seeded simple", async () => {
  const { client, calls } = makeClient();
  const { initialize, initCalls } = makeInit();
  const res = await createProductCore(client, ROW, [], initialize);
  assert.ok(res.ok);
  assert.ok(!calls.some((c) => c.table === "product_variants"));
  assert.ok(!calls.some((c) => c.table === "inventory"));
  assert.equal(initCalls[0].variants.length, 0);
  assert.equal(initCalls[0].simpleStock, 7, "simple seed = row.stock_quantity");
});

test("product insert failure: nothing to clean, 23505 flagged as duplicate identity, initializer NOT called", async () => {
  const { client, calls } = makeClient({
    productInsert: { data: null, error: { code: "23505", message: "dup" } },
  });
  const { initialize, initCalls } = makeInit();
  const res = await createProductCore(client, ROW, VROWS, initialize);
  assert.ok(!res.ok);
  if (!res.ok) {
    assert.equal(res.stage, "product_insert");
    assert.equal(res.duplicateIdentity, true);
    assert.equal(res.cleanup, "not_needed");
  }
  assert.ok(!calls.some((c) => c.kind === "delete"), "no deletes needed");
  assert.equal(initCalls.length, 0, "initializer never runs when the product insert fails");
});

test("SIMPLE init failure rolls the product back — no partial product survives (inventory_insert stage)", async () => {
  const { client, calls } = makeClient();
  const { initialize } = makeInit({ ok: false, reason: "not_a_pristine_seed" });
  const res = await createProductCore(client, ROW, [], initialize); // simple product
  assert.ok(!res.ok);
  if (!res.ok) {
    assert.equal(res.stage, "inventory_insert");
    assert.equal(res.duplicateIdentity, false);
    assert.equal(res.cleanup, "done");
  }
  const deletes = calls.filter((c) => c.kind === "delete");
  assert.deepEqual(deletes.map((d) => d.table), ["products"]);
  assert.equal(deletes[0].value, "p-new");
});

test("VARIANT init failure rolls back the product only — FK cascade removes the children (variant_insert stage)", async () => {
  const { client, calls } = makeClient();
  const { initialize } = makeInit({ ok: false, reason: "duplicate_variant", duplicateIdentity: true });
  const res = await createProductCore(client, ROW, VROWS, initialize);
  assert.ok(!res.ok);
  if (!res.ok) {
    assert.equal(res.stage, "variant_insert");
    assert.equal(res.duplicateIdentity, true);
    assert.equal(res.cleanup, "done");
  }
  const deletes = calls.filter((c) => c.kind === "delete").map((d) => d.table);
  assert.deepEqual(deletes, ["products"], "only the product row is deleted; inventory + variants cascade");
});

// ── INV.6A/6B create-time authority (computed in TS, applied by the initializer) ──

test("VARIANT create: parent seed = Σ variants is delegated; top-level stock is IGNORED", async () => {
  const { client } = makeClient();
  const { initialize, initCalls } = makeInit();
  const vrows: CreateVariantRow[] = [
    { variant_name: "a", variant_name_en: null, sku: "s-1", barcode: null, color: null, size: null, price: null, stock_quantity: 2 },
    { variant_name: "b", variant_name_en: null, sku: "s-2", barcode: null, color: null, size: null, price: null, stock_quantity: 3 },
    { variant_name: "c", variant_name_en: null, sku: "s-3", barcode: null, color: null, size: null, price: null, stock_quantity: 4 },
  ];
  // top-level stock 999 must NOT be authoritative for a variant product.
  const res = await createProductCore(client, { sku: "mk9", name_ar: "x", stock_quantity: 999 }, vrows, initialize, { seedQuantity: 999 });
  assert.ok(res.ok);
  // The core hands normalized variants to the initializer (the RPC sums them); the
  // simpleStock authority is 0 for a variant product, never the top-level 999.
  assert.equal(initCalls[0].simpleStock, 0);
  assert.deepEqual(initCalls[0].variants.map((v) => v.stock_quantity), [2, 3, 4]);
});

test("VARIANT create: a blank variant stock normalizes to 0 before delegation", async () => {
  const { client } = makeClient();
  const { initialize, initCalls } = makeInit();
  const vrows: CreateVariantRow[] = [
    { variant_name: "a", variant_name_en: null, sku: "s-1", barcode: null, color: null, size: null, price: null, stock_quantity: null },
    { variant_name: "b", variant_name_en: null, sku: "s-2", barcode: null, color: null, size: null, price: null, stock_quantity: 5 },
  ];
  const res = await createProductCore(client, { sku: "mk9", name_ar: "x" }, vrows, initialize);
  assert.ok(res.ok);
  assert.deepEqual(initCalls[0].variants.map((v) => v.stock_quantity), [0, 5], "blank variant stock normalized to 0");
});

test("VARIANT create: a malformed variant stock fails closed BEFORE any insert or delegation", async () => {
  for (const bad of [-1, 1.5, Number.NaN, Infinity]) {
    const { client, calls } = makeClient();
    const { initialize, initCalls } = makeInit();
    const vrows: CreateVariantRow[] = [
      { variant_name: "a", variant_name_en: null, sku: "s-1", barcode: null, color: null, size: null, price: null, stock_quantity: bad },
    ];
    const res = await createProductCore(client, { sku: "mk9", name_ar: "x" }, vrows, initialize);
    assert.ok(!res.ok);
    if (!res.ok) {
      assert.equal(res.stage, "invalid_variant_stock");
      assert.equal(res.cleanup, "not_needed");
    }
    assert.equal(calls.length, 0, "no product insert on a malformed variant stock");
    assert.equal(initCalls.length, 0, "initializer never runs on a malformed variant stock");
  }
});

test("SIMPLE create: a malformed seed fails closed before any insert or delegation", async () => {
  for (const bad of [-1, 1.5, Number.NaN]) {
    const { client, calls } = makeClient();
    const { initialize, initCalls } = makeInit();
    const res = await createProductCore(client, { sku: "mk9", name_ar: "x" }, [], initialize, { seedQuantity: bad });
    assert.ok(!res.ok);
    if (!res.ok) assert.equal(res.stage, "invalid_seed");
    assert.equal(calls.length, 0, "nothing inserted on a malformed simple seed");
    assert.equal(initCalls.length, 0, "initializer never runs on a malformed simple seed");
  }
});

test("a failed compensation is REPORTED, never silent", async () => {
  const { client } = makeClient({ deleteError: { message: "rls denied" } });
  const { initialize } = makeInit({ ok: false, reason: "not_a_pristine_seed" });
  const res = await createProductCore(client, ROW, VROWS, initialize);
  assert.ok(!res.ok);
  if (!res.ok) assert.equal(res.cleanup, "failed");
});

// ── opts.seedQuantity / mirror retirement ─────────────────────────────────────

test("default caller (no opts): simple seed comes from row.stock_quantity", async () => {
  const { client } = makeClient();
  const { initialize, initCalls } = makeInit();
  await createProductCore(client, ROW, [], initialize); // ROW.stock_quantity === 7
  assert.equal(initCalls[0].simpleStock, 7);
});

test("row without stock_quantity and no opts seeds 0", async () => {
  const { client } = makeClient();
  const { initialize, initCalls } = makeInit();
  await createProductCore(client, { sku: "mk9", name_ar: "x" }, [], initialize);
  assert.equal(initCalls[0].simpleStock, 0);
});

test("opts.seedQuantity overrides ONLY the simple seed — product row strips the mirror, not mutated", async () => {
  const { client, calls } = makeClient();
  const { initialize, initCalls } = makeInit();
  const row = { sku: "mk9", name_ar: "سيروم", stock_quantity: 7 };
  const before = JSON.stringify(row);
  await createProductCore(client, row, [], initialize, { seedQuantity: 42 });

  // the simple seed uses the override…
  assert.equal(initCalls[0].simpleStock, 42);

  // …the PRODUCT row inserted has NO stock_quantity (INV.4E: the mirror is retired
  // and stripped before insert), and the caller's row object is not mutated.
  const prod = calls.find((c) => c.kind === "insert-select")!.values as Record<string, unknown>;
  assert.ok(!("stock_quantity" in prod), "product row strips the retired stock_quantity mirror");
  assert.equal(JSON.stringify(row), before, "row object not mutated");
});

test("Shopify shape: row has NO stock_quantity, seedQuantity carries the store qty", async () => {
  const { client, calls } = makeClient();
  const { initialize, initCalls } = makeInit();
  const shopifyRow = { sku: "SH-1", name_en: "Serum", approval: "Approved" }; // no stock_quantity
  await createProductCore(client, shopifyRow, [], initialize, { seedQuantity: 9 });
  const prod = calls.find((c) => c.kind === "insert-select")!.values as Record<string, unknown>;
  assert.ok(!("stock_quantity" in prod), "no stock_quantity injected into the product row");
  assert.equal(initCalls[0].simpleStock, 9, "simple seed from seedQuantity");
});

test("projectVariantInsertRows: meaningful rows only, blanks -> null, numbers real", () => {
  const rows = projectVariantInsertRows([
    { variant_name: "وردي", variant_name_en: "", sku: "mk9-1", barcode: " ", color: "", size: "", price: "10", stock_quantity: "" },
    { variant_name: " ", variant_name_en: "", sku: "", barcode: "", color: "", size: "", price: "", stock_quantity: "" },
  ]);
  assert.equal(rows.length, 1, "empty row dropped");
  assert.equal(rows[0].barcode, null);
  assert.equal(rows[0].price, 10);
  assert.ok(!("parent_product_id" in rows[0]) || rows[0].parent_product_id === undefined, "parent stamped by the initializer, not here");
});
