// Tests for createProductCore (Phase UI.5). PURE — scripted fake client.
// Run: node --conditions=react-server --experimental-strip-types --test lib/products/product-create.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import {
  createProductCore,
  projectVariantInsertRows,
  type CreateVariantRow,
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
    invInsert: { error: null as { message: string } | null },
    variantInsert: { error: null as { code?: string; message: string } | null },
    deleteError: null as unknown,
    ...over,
  };
  const calls: Call[] = [];
  const client = {
    from(table: string) {
      return {
        insert(values: Record<string, unknown> | Record<string, unknown>[]) {
          const base = {
            select(_c: string) {
              return {
                single() {
                  calls.push({ kind: "insert-select", table, values });
                  return Promise.resolve(o.productInsert);
                },
              };
            },
            then<T>(onOk: (v: { error: unknown }) => T, onErr?: (e: unknown) => T) {
              calls.push({ kind: "insert", table, values });
              const out = table === "inventory" ? o.invInsert : o.variantInsert;
              return Promise.resolve(out).then(onOk, onErr);
            },
          };
          return base;
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

const ROW = { sku: "mk9", name_ar: "سيروم", stock_quantity: 7 };
const VROWS: CreateVariantRow[] = [
  { variant_name: "وردي", variant_name_en: "Pink", sku: "mk9-1", barcode: "4006381333948", color: null, size: null, price: 10, stock_quantity: 1 },
];

test("happy path: product -> inventory -> variants, variants stamped with the new product id", async () => {
  const { client, calls } = makeClient();
  const res = await createProductCore(client, ROW, VROWS);
  assert.deepEqual(res, { ok: true, productId: "p-new" });
  assert.deepEqual(
    calls.map((c) => `${c.kind}:${c.table}`),
    ["insert-select:products", "insert:inventory", "insert:product_variants"],
  );
  const vInsert = calls[2].values as Record<string, unknown>[];
  assert.equal(vInsert[0].parent_product_id, "p-new");
  assert.equal(vInsert[0].sku, "mk9-1");
});

test("no variants -> no variant insert at all", async () => {
  const { client, calls } = makeClient();
  const res = await createProductCore(client, ROW, []);
  assert.ok(res.ok);
  assert.ok(!calls.some((c) => c.table === "product_variants"));
});

test("product insert failure: nothing to clean, 23505 flagged as duplicate identity", async () => {
  const { client, calls } = makeClient({
    productInsert: { data: null, error: { code: "23505", message: "dup" } },
  });
  const res = await createProductCore(client, ROW, VROWS);
  assert.ok(!res.ok);
  if (!res.ok) {
    assert.equal(res.stage, "product_insert");
    assert.equal(res.duplicateIdentity, true);
    assert.equal(res.cleanup, "not_needed");
  }
  assert.ok(!calls.some((c) => c.kind === "delete"), "no deletes needed");
});

test("inventory failure rolls the product back — no partial product survives", async () => {
  const { client, calls } = makeClient({ invInsert: { error: { message: "inv down" } } });
  const res = await createProductCore(client, ROW, VROWS);
  assert.ok(!res.ok);
  if (!res.ok) {
    assert.equal(res.stage, "inventory_insert");
    assert.equal(res.cleanup, "done");
  }
  const deletes = calls.filter((c) => c.kind === "delete");
  assert.deepEqual(deletes.map((d) => d.table), ["products"]);
  assert.equal(deletes[0].value, "p-new");
  assert.ok(!calls.some((c) => c.table === "product_variants" && c.kind === "insert"), "variants never attempted");
});

test("variant failure rolls back variants, inventory and the product — full compensation", async () => {
  const { client, calls } = makeClient({ variantInsert: { error: { code: "23505", message: "dup sku" } } });
  const res = await createProductCore(client, ROW, VROWS);
  assert.ok(!res.ok);
  if (!res.ok) {
    assert.equal(res.stage, "variant_insert");
    assert.equal(res.duplicateIdentity, true);
    assert.equal(res.cleanup, "done");
  }
  const deletes = calls.filter((c) => c.kind === "delete").map((d) => d.table);
  assert.deepEqual(deletes, ["product_variants", "inventory", "products"], "reverse order");
});

test("a failed compensation is REPORTED, never silent", async () => {
  const { client } = makeClient({
    variantInsert: { error: { message: "boom" } },
    deleteError: { message: "rls denied" },
  });
  const res = await createProductCore(client, ROW, VROWS);
  assert.ok(!res.ok);
  if (!res.ok) assert.equal(res.cleanup, "failed");
});

// ── opts.seedQuantity (P6) ────────────────────────────────────────────────────

test("default caller (no opts): inventory seeds from row.stock_quantity", async () => {
  const { client, calls } = makeClient();
  await createProductCore(client, ROW, []); // ROW.stock_quantity === 7
  const inv = calls.find((c) => c.table === "inventory")!.values as Record<string, unknown>;
  assert.equal(inv.stock_quantity, 7);
});

test("row without stock_quantity and no opts seeds 0", async () => {
  const { client, calls } = makeClient();
  await createProductCore(client, { sku: "mk9", name_ar: "x" }, []);
  const inv = calls.find((c) => c.table === "inventory")!.values as Record<string, unknown>;
  assert.equal(inv.stock_quantity, 0);
});

test("opts.seedQuantity overrides ONLY the inventory seed — product row strips the mirror, not mutated", async () => {
  const { client, calls } = makeClient();
  const row = { sku: "mk9", name_ar: "سيروم", stock_quantity: 7 };
  const before = JSON.stringify(row);
  await createProductCore(client, row, [], { seedQuantity: 42 });

  // inventory seed uses the override…
  const inv = calls.find((c) => c.table === "inventory")!.values as Record<string, unknown>;
  assert.equal(inv.stock_quantity, 42);
  assert.equal(inv.low_stock_threshold, 5);
  assert.equal(inv.sold_quantity, 0);

  // …the PRODUCT row inserted has NO stock_quantity (INV.4E: the mirror is retired
  // and stripped before insert), and the caller's row object is not mutated.
  const prod = calls.find((c) => c.kind === "insert-select")!.values as Record<string, unknown>;
  assert.ok(!("stock_quantity" in prod), "product row strips the retired stock_quantity mirror");
  assert.equal(JSON.stringify(row), before, "row object not mutated");
});

test("Shopify shape: row has NO stock_quantity, seedQuantity carries the store qty", async () => {
  const { client, calls } = makeClient();
  const shopifyRow = { sku: "SH-1", name_en: "Serum", approval: "Approved" }; // no stock_quantity
  await createProductCore(client, shopifyRow, [], { seedQuantity: 9 });
  const prod = calls.find((c) => c.kind === "insert-select")!.values as Record<string, unknown>;
  assert.ok(!("stock_quantity" in prod), "no stock_quantity injected into the product row");
  const inv = calls.find((c) => c.table === "inventory")!.values as Record<string, unknown>;
  assert.equal(inv.stock_quantity, 9, "inventory seeded from seedQuantity");
});

test("projectVariantInsertRows: meaningful rows only, blanks -> null, numbers real", () => {
  const rows = projectVariantInsertRows([
    { variant_name: "وردي", variant_name_en: "", sku: "mk9-1", barcode: " ", color: "", size: "", price: "10", stock_quantity: "" },
    { variant_name: " ", variant_name_en: "", sku: "", barcode: "", color: "", size: "", price: "", stock_quantity: "" },
  ]);
  assert.equal(rows.length, 1, "empty row dropped");
  assert.equal(rows[0].barcode, null);
  assert.equal(rows[0].price, 10);
  assert.ok(!("parent_product_id" in rows[0]) || rows[0].parent_product_id === undefined, "parent stamped by the core, not here");
});
