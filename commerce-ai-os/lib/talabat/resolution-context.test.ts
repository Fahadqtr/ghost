// Tests for the Talabat resolution-context loader. Fake Supabase client only —
// NO real Supabase, NO network.
// Run: node --conditions=react-server --experimental-strip-types --test lib/talabat/resolution-context.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { loadTalabatResolutionContext, resolveExactTalabatChannel } from "./resolution-context.ts";

// A minimal chainable fake: from(table).select(...).eq(col,val).range(from,to) → {data,error}.
// `tables` maps a table name to either a full array (auto-paginated by range) or a
// function (filters, range) => {data, error}. `calls` records every table access.
function makeAdmin(tables: Record<string, any>, calls: any[] = []) {
  return {
    calls,
    from(table: string) {
      const filters: Record<string, unknown> = {};
      let rng: [number, number] | null = null;
      let orderCol: string | null = null;
      const b: any = {
        select() { return b; },
        eq(col: string, val: unknown) { filters[col] = val; return b; },
        order(col: string) { orderCol = col; return b; },
        range(from: number, to: number) { rng = [from, to]; return b; },
        then(resolve: (v: any) => void, reject: (e: any) => void) {
          try {
            calls.push({ table, filters: { ...filters }, range: rng, order: orderCol });
            const src = tables[table];
            if (typeof src === "function") return resolve(src(filters, rng));
            let rows: any[] = Array.isArray(src) ? src : [];
            // apply eq filters
            for (const [k, v] of Object.entries(filters)) rows = rows.filter((r) => r[k] === v);
            if (rng) rows = rows.slice(rng[0], rng[1] + 1);
            resolve({ data: rows, error: null });
          } catch (e) { reject(e); }
        },
      };
      return b;
    },
  };
}

test("resolveExactTalabatChannel: 0 → missing, 1 → ok, >1 → ambiguous (exact name only)", () => {
  assert.deepEqual(resolveExactTalabatChannel([]), { status: "missing" });
  assert.deepEqual(resolveExactTalabatChannel([{ id: "c1", name: "Talabat" }]), { status: "ok", id: "c1" });
  assert.deepEqual(resolveExactTalabatChannel([{ id: "c1", name: "talabat" }, { id: "c2", name: "Talabat" }]), { status: "ambiguous" });
  // a "%talabat%" sibling is NOT the exact channel
  assert.deepEqual(resolveExactTalabatChannel([{ id: "c9", name: "Talabat Archive" }]), { status: "missing" });
});

test("exactly one Talabat channel is required (missing → manual_review)", async () => {
  const admin = makeAdmin({ channels: [{ id: "c9", name: "Talabat Archive" }] });
  const res = await loadTalabatResolutionContext(admin);
  assert.deepEqual(res, { status: "manual_review", reason: "talabat_channel_unresolved" });
});

test("ambiguous Talabat channels → manual_review talabat_channel_unresolved", async () => {
  const admin = makeAdmin({ channels: [{ id: "a", name: "Talabat" }, { id: "b", name: "TALABAT" }] });
  const res = await loadTalabatResolutionContext(admin);
  assert.deepEqual(res, { status: "manual_review", reason: "talabat_channel_unresolved" });
});

test("resolution context paginates past 1000 rows (no row lost or duplicated)", async () => {
  const products = Array.from({ length: 1503 }, (_, i) => ({ id: `p${String(i).padStart(5, "0")}`, sku: `S${i}`, barcode: null, name_en: `N${i}` }));
  const admin = makeAdmin({
    channels: [{ id: "cT", name: "Talabat" }],
    channel_variant_mappings: [],
    products,
    product_variants: [],
  });
  const res = await loadTalabatResolutionContext(admin);
  assert.equal(res.status, "ok");
  if (res.status === "ok") {
    assert.equal(res.context.products.length, 1503);                 // all pages loaded
    assert.equal(new Set(res.context.products.map((p) => p.id)).size, 1503); // none duplicated
  }
});

test("every paginated query orders by id BEFORE range (deterministic pagination)", async () => {
  const calls: any[] = [];
  const admin = makeAdmin({
    channels: [{ id: "cT", name: "Talabat" }],
    channel_variant_mappings: [],
    products: [],
    product_variants: [],
  }, calls);
  await loadTalabatResolutionContext(admin);
  for (const table of ["channel_variant_mappings", "products", "product_variants"]) {
    const c = calls.find((x) => x.table === table);
    assert.ok(c, `${table} queried`);
    assert.equal(c.order, "id", `${table} must order by id`);        // deterministic key
    assert.ok(Array.isArray(c.range), `${table} must use range()`);  // paginated
  }
});

test("the mapping query is restricted to the exact resolved channel id", async () => {
  const calls: any[] = [];
  const admin = makeAdmin({
    channels: [{ id: "cT", name: "Talabat" }],
    channel_variant_mappings: [
      { channel_id: "cT", channel_product_id: "CP1", exported_sku: "V1", exported_barcode: null, master_product_id: "p1", master_variant_sku: "V1", mapping_status: "active" },
      { channel_id: "cOTHER", channel_product_id: "CPX", exported_sku: "VX", exported_barcode: null, master_product_id: "pX", master_variant_sku: "VX", mapping_status: "active" },
    ],
    products: [],
    product_variants: [],
  }, calls);
  const res = await loadTalabatResolutionContext(admin);
  assert.equal(res.status, "ok");
  if (res.status === "ok") {
    assert.equal(res.channelId, "cT");
    assert.equal(res.context.mappings.length, 1);            // only the cT mapping
    assert.equal(res.context.mappings[0].masterProductId, "p1");
  }
  const mapCall = calls.find((c) => c.table === "channel_variant_mappings");
  assert.equal(mapCall.filters.channel_id, "cT");            // restricted to the exact channel
});

test("any query error → fail closed (status error, no partial context)", async () => {
  const admin = makeAdmin({
    channels: [{ id: "cT", name: "Talabat" }],
    channel_variant_mappings: () => ({ data: null, error: { message: "boom" } }),
    products: [],
    product_variants: [],
  });
  const res = await loadTalabatResolutionContext(admin);
  assert.deepEqual(res, { status: "error" });
});

test("rows are mapped into the resolver's context shape", async () => {
  const admin = makeAdmin({
    channels: [{ id: "cT", name: "Talabat" }],
    channel_variant_mappings: [{ channel_id: "cT", channel_product_id: "CP1", exported_sku: "V1", exported_barcode: "B1", master_product_id: "p1", master_variant_sku: "V1", mapping_status: "active" }],
    products: [{ id: "p1", sku: "PSKU", barcode: "PBC", name_en: "Prod One" }],
    product_variants: [{ parent_product_id: "p1", sku: "V1", barcode: "B1" }],
  });
  const res = await loadTalabatResolutionContext(admin);
  assert.equal(res.status, "ok");
  if (res.status === "ok") {
    assert.deepEqual(res.context.mappings[0], { channelProductId: "CP1", exportedSku: "V1", exportedBarcode: "B1", masterProductId: "p1", masterVariantSku: "V1", mappingStatus: "active" });
    assert.deepEqual(res.context.products[0], { id: "p1", sku: "PSKU", barcode: "PBC", title: "Prod One" });
    assert.deepEqual(res.context.variants[0], { parentProductId: "p1", sku: "V1", barcode: "B1" });
  }
});
