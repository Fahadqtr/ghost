// INV.2C — Availability read-model contract + engine quantity-protection proof.
//
// PURE: read-model is pure; the engine test uses an in-memory fake client and a
// products/inventory store to prove availability writes touch ONLY
// products.stock_status and never a quantity column.
//
// Run: node --conditions=react-server --experimental-strip-types --test lib/availability/availability.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { isAvailable, normalizeAvailability, availabilityFromInStock, availabilityLabel, allVariantsOut } from "./read.ts";
import { setProductAvailabilityState, writeProductAvailability, setVariantAvailabilityState, writeVariantAvailability } from "./engine.ts";

// ── read-model ────────────────────────────────────────────────────────────────

test("isAvailable: only explicit In Stock is available", () => {
  assert.equal(isAvailable("In Stock"), true);
  assert.equal(isAvailable("Out of Stock"), false);
});

test("isAvailable never reinterprets unknown/legacy values (no quantity derivation)", () => {
  for (const v of ["Low Stock", "", "  ", null, undefined, "in stock", "INSTOCK", 0, 1, 37, "Preorder"]) {
    assert.equal(isAvailable(v as unknown), false, `unknown value ${JSON.stringify(v)} is not available`);
  }
});

test("normalizeAvailability returns canonical state or null, never a guess", () => {
  assert.equal(normalizeAvailability("In Stock"), "In Stock");
  assert.equal(normalizeAvailability("  Out of Stock  "), "Out of Stock");
  assert.equal(normalizeAvailability("Low Stock"), null);
  assert.equal(normalizeAvailability(null), null);
  assert.equal(normalizeAvailability("whatever"), null);
});

test("availabilityFromInStock maps the boolean toggle to the two allowed states", () => {
  assert.equal(availabilityFromInStock(true), "In Stock");
  assert.equal(availabilityFromInStock(false), "Out of Stock");
});

test("availabilityLabel is localized and safe for unknowns", () => {
  assert.equal(availabilityLabel("In Stock", "en"), "In Stock");
  assert.equal(availabilityLabel("Out of Stock", "en"), "Out of Stock");
  assert.equal(availabilityLabel("Low Stock", "en"), "Unknown");
});

// ── engine: writes ONLY products.stock_status; never a quantity column ─────────

function fakeClient(seedInventory: Record<string, number> = {}) {
  const products = new Map<string, Record<string, unknown>>();
  const inventory = new Map<string, { stock_quantity: number }>();
  for (const [pid, qty] of Object.entries(seedInventory)) inventory.set(pid, { stock_quantity: qty });
  const writes: { table: string; values: Record<string, unknown>; ids: string[] }[] = [];
  const client = {
    from(table: string) {
      return {
        update(values: Record<string, unknown>) {
          return {
            in(_col: string, ids: string[]) {
              writes.push({ table, values, ids: [...ids] });
              // The engine only ever targets products; if it ever targeted a
              // quantity table this fake would record it and the assertions below
              // would fail. We deliberately DO NOT mutate inventory here.
              if (table === "products") for (const id of ids) products.set(id, { ...(products.get(id) ?? { id }), ...values });
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
  };
  return { client, products, inventory, writes };
}

test("engine writes only products.stock_status; every write targets products", async () => {
  const { client, products, writes } = fakeClient();
  const res = await setProductAvailabilityState(client, "p1", false);
  assert.deepEqual(res, { ok: true, count: 1 });
  assert.equal(products.get("p1")?.stock_status, "Out of Stock");
  assert.ok(writes.length > 0);
  for (const w of writes) {
    assert.equal(w.table, "products", "only the products table is written");
    assert.deepEqual(Object.keys(w.values), ["stock_status"], "only stock_status is set");
  }
});

test("QUANTITY PROTECTION: toggling availability never changes stock_quantity", async () => {
  for (const seed of [0, 1, 37, 1_000_000]) {
    const { client, inventory, writes } = fakeClient({ p1: seed });
    // toggle Out, then In, then Out again — several times.
    for (const inStock of [false, true, false, true]) {
      const r = await setProductAvailabilityState(client, "p1", inStock);
      assert.equal(r.ok, true);
      assert.equal(inventory.get("p1")?.stock_quantity, seed, `stock stays ${seed} after toggle`);
    }
    // No write ever targeted a quantity/shelf/sold table, or carried such a field.
    for (const w of writes) {
      assert.equal(w.table, "products");
      for (const k of ["stock_quantity", "sold_quantity"]) assert.equal(k in w.values, false, `${k} never written`);
    }
  }
});

test("writeProductAvailability: rejects unknown state, dedupes ids, counts", async () => {
  const { client, products } = fakeClient();
  const bad = await writeProductAvailability(client, ["p1"], "Low Stock" as unknown as "In Stock");
  assert.equal(bad.ok, false);
  const ok = await writeProductAvailability(client, ["p1", "p1", "p2", ""], "In Stock");
  assert.deepEqual(ok, { ok: true, count: 2 });
  assert.equal(products.get("p1")?.stock_status, "In Stock");
  assert.equal(products.get("p2")?.stock_status, "In Stock");
});

test("writeProductAvailability: empty id list is a no-op success", async () => {
  const { client, writes } = fakeClient();
  const res = await writeProductAvailability(client, [], "Out of Stock");
  assert.deepEqual(res, { ok: true, count: 0 });
  assert.equal(writes.length, 0);
});

// ── INV.2E: variant engine writes ONLY product_variants.stock_status ──────────

test("variant engine writes product_variants.stock_status; nothing else", async () => {
  const { client, writes } = fakeClient();
  const inN = await setVariantAvailabilityState(client, "v1", true);
  const outN = await setVariantAvailabilityState(client, "v2", false);
  assert.deepEqual(inN, { ok: true, count: 1 });
  assert.deepEqual(outN, { ok: true, count: 1 });
  assert.ok(writes.length >= 2);
  for (const w of writes) {
    assert.equal(w.table, "product_variants", "only the product_variants table is written");
    assert.deepEqual(Object.keys(w.values), ["stock_status"], "only stock_status is set");
  }
  assert.equal(writes.find((w) => w.ids.includes("v1"))?.values.stock_status, "In Stock");
  assert.equal(writes.find((w) => w.ids.includes("v2"))?.values.stock_status, "Out of Stock");
});

test("QUANTITY PROTECTION: variant availability writes never carry a quantity field", async () => {
  const { client, writes } = fakeClient();
  for (const inStock of [false, true, false]) await setVariantAvailabilityState(client, "v1", inStock);
  for (const w of writes) {
    assert.equal(w.table, "product_variants");
    for (const k of ["stock_quantity", "sold_quantity"]) assert.equal(k in w.values, false, `${k} never written`);
  }
});

test("writeVariantAvailability rejects unknown state, dedupes ids, counts", async () => {
  const { client, writes } = fakeClient();
  const bad = await writeVariantAvailability(client, ["v1"], "Low Stock" as unknown as "In Stock");
  assert.equal(bad.ok, false);
  const ok = await writeVariantAvailability(client, ["v1", "v1", "v2", ""], "Out of Stock");
  assert.deepEqual(ok, { ok: true, count: 2 });
  assert.ok(writes.every((w) => w.table === "product_variants"));
});

// ── INV.2E: allVariantsOut diagnostic (surface only, explicit) ────────────────

test("allVariantsOut: true only when there are variants and none is available", () => {
  assert.equal(allVariantsOut([]), false, "no variants → nothing to diagnose");
  assert.equal(allVariantsOut(["Out of Stock", "Out of Stock"]), true);
  assert.equal(allVariantsOut(["Out of Stock", "In Stock"]), false, "one in stock → not all out");
  assert.equal(allVariantsOut([null, "Low Stock", ""]), true, "unknown/unset count as not-available");
});
