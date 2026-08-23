// Tests for the Malikas V2 Shopify Catalog READ layer (Phase UI.3B).
// The Supabase client, the pure projector, and the Shopify reader are all
// injected — no real database, no network, no server-only value import resolved.
// Run: node --conditions=react-server --experimental-strip-types --test lib/catalog-v2/shopify-catalog-read.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyShopifyUnavailable,
  loadShopifyCatalog,
  type CatalogReadClient,
  type CatalogQueryResult,
  type CatalogRangeBuilder,
  type ShopifyReader,
} from "./shopify-catalog-read.ts";
import { projectShopifyCatalog, type ShopifyProductInput } from "./shopify-catalog-view.ts";

// Inject the REAL pure projector so the read layer never resolves its lazy
// dynamic import under node:test.
const PROJECTOR = { projectShopifyCatalog };

// ── Fake paginated Supabase-like client ──────────────────────────────────────

const SERVER_MAX = 1000;

interface FakeTableCfg {
  rows?: unknown[];
  failAtCall?: number; // 1-based page index whose result is an error
  throwAtCall?: number; // 1-based page index whose builder throws synchronously
}
interface CallRecord {
  table: string;
  columns: string;
  orders: { column: string; ascending: boolean }[];
  range: [number, number];
}

function fakePagedClient(cfg: Record<string, FakeTableCfg>): { client: CatalogReadClient; calls: CallRecord[] } {
  const calls: CallRecord[] = [];
  const counts: Record<string, number> = {};
  const client: CatalogReadClient = {
    from(table: string) {
      const orders: { column: string; ascending: boolean }[] = [];
      let columns = "";
      let pending: CatalogQueryResult = { data: [], error: null };
      const builder: CatalogRangeBuilder = {
        order(column: string, options: { ascending: boolean }) {
          orders.push({ column, ascending: options.ascending });
          return builder;
        },
        range(from: number, to: number) {
          const n = (counts[table] = (counts[table] ?? 0) + 1);
          calls.push({ table, columns, orders: orders.map((o) => ({ ...o })), range: [from, to] });
          const t = cfg[table] ?? {};
          if (t.throwAtCall === n) throw new Error("BUILDER BOOM SECRET");
          if (t.failAtCall === n) {
            pending = { data: null, error: { message: "PAGE SECRET", code: "42P01" } };
          } else {
            const all = t.rows ?? [];
            const end = Math.min(to, from + SERVER_MAX - 1);
            pending = { data: all.slice(from, end + 1), error: null };
          }
          return builder;
        },
        then<TResult1 = CatalogQueryResult, TResult2 = never>(
          onfulfilled?: ((value: CatalogQueryResult) => TResult1 | PromiseLike<TResult1>) | null,
          onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
        ): PromiseLike<TResult1 | TResult2> {
          return Promise.resolve(pending).then(onfulfilled, onrejected);
        },
      };
      return {
        select(cols: string) {
          columns = cols;
          return builder;
        },
      };
    },
  };
  return { client, calls };
}

const callsFor = (calls: CallRecord[], table: string): CallRecord[] => calls.filter((c) => c.table === table);

// ── Fake Shopify reader (counts calls; never touches the network) ────────────

function fakeShopify(result: { products?: ShopifyProductInput[]; error?: string } | (() => never)): {
  reader: ShopifyReader;
  count: () => number;
} {
  let n = 0;
  const reader: ShopifyReader = {
    async fetchAllShopifyProducts() {
      n += 1;
      if (typeof result === "function") return result();
      return result;
    },
  };
  return { reader, count: () => n };
}

// ── Row builders ─────────────────────────────────────────────────────────────

function rawProduct(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "p1", sku: "MK-1", barcode: "BAR-1", name_ar: "منتج", name_en: "Product", price: 10, image_url: "https://img/1.jpg", ...over };
}
function shopProduct(over: Partial<ShopifyProductInput> = {}): ShopifyProductInput {
  return {
    id: "gid://product/1",
    title: "Shopify Product",
    status: "ACTIVE",
    imageUrl: "https://shop/img.jpg",
    variants: [{ id: "gid://variant/1", sku: "MK-1", barcode: "BAR-1", inventoryItemId: "gid://inv/1" }],
    ...over,
  };
}

// ── Happy path ───────────────────────────────────────────────────────────────

test("ok: matches master ↔ Shopify, surfaces orphans, marks not partial, calls Shopify once", async () => {
  const products = [rawProduct({ id: "p1", sku: "MK-1" }), rawProduct({ id: "p2", sku: "MK-2" })];
  const shopify = fakeShopify({
    products: [
      shopProduct({ id: "gid://product/1", variants: [{ id: "gid://variant/1", sku: "MK-1", barcode: "", inventoryItemId: "gid://inv/1" }] }),
      shopProduct({ id: "gid://product/2", variants: [{ id: "gid://variant/2", sku: "ORPHAN", barcode: "OB", inventoryItemId: "" }] }),
    ],
  });
  const { client } = fakePagedClient({ products: { rows: products }, product_variants: { rows: [] } });
  const res = await loadShopifyCatalog(client, { project: PROJECTOR, shopify: shopify.reader });

  assert.equal(res.status, "ok");
  assert.equal(res.shopifyAvailable, true);
  assert.equal(res.partial, false);
  assert.equal(res.rows.length, 2);
  assert.equal(shopify.count(), 1, "Shopify read called exactly once");

  const p1 = res.rows.find((r) => r.masterProductId === "p1")!;
  assert.equal(p1.matchStatus, "matched_sku");
  assert.equal(p1.shopifyVariantId, "gid://variant/1");
  const p2 = res.rows.find((r) => r.masterProductId === "p2")!;
  assert.equal(p2.matchStatus, "unmatched");

  assert.equal(res.orphanVariants.length, 1);
  assert.equal(res.orphanVariants[0]!.shopifyVariantId, "gid://variant/2");
  assert.equal(res.orphanVariants[0]!.reason, "no_master_match");
});

test("read uses the exact catalog column whitelists and deterministic ordering", async () => {
  const { client, calls } = fakePagedClient({ products: { rows: [rawProduct()] }, product_variants: { rows: [] } });
  await loadShopifyCatalog(client, { project: PROJECTOR, shopify: fakeShopify({ products: [] }).reader });

  const p = callsFor(calls, "products")[0]!;
  assert.equal(p.columns, "id, sku, barcode, name_ar, name_en, price, image_url");
  assert.deepEqual(p.orders, [
    { column: "sku", ascending: true },
    { column: "id", ascending: true },
  ]);
  assert.ok(!/\*/.test(p.columns), "never select *");
  assert.ok(!/stock|inventory|quantity|order|customer/i.test(p.columns), "no stock/order/customer columns");

  const v = callsFor(calls, "product_variants")[0]!;
  assert.equal(v.columns, "id, parent_product_id, sku, barcode, price");
  assert.deepEqual(v.orders, [
    { column: "parent_product_id", ascending: true },
    { column: "id", ascending: true },
  ]);
});

// ── Pagination ───────────────────────────────────────────────────────────────

test("products across two pages are all preserved with correct ranges", async () => {
  const products: Record<string, unknown>[] = [];
  for (let i = 0; i < 1500; i++) products.push(rawProduct({ id: `p${i}`, sku: `SKU-${i}` }));
  const { client, calls } = fakePagedClient({ products: { rows: products }, product_variants: { rows: [] } });
  const res = await loadShopifyCatalog(client, { project: PROJECTOR, shopify: fakeShopify({ products: [] }).reader });

  assert.equal(res.status, "ok");
  assert.equal(res.rows.length, 1500);
  assert.deepEqual(
    callsFor(calls, "products").map((c) => c.range),
    [
      [0, 999],
      [1000, 1999],
    ],
  );
});

// ── Master errors fail closed ────────────────────────────────────────────────

test("products page error → master_error, no rows, no orphans, Shopify not read", async () => {
  const shopify = fakeShopify({ products: [shopProduct()] });
  const { client } = fakePagedClient({ products: { rows: [rawProduct()], failAtCall: 1 } });
  const res = await loadShopifyCatalog(client, { project: PROJECTOR, shopify: shopify.reader });

  assert.equal(res.status, "master_error");
  assert.deepEqual(res.rows, []);
  assert.deepEqual(res.orphanVariants, []);
  assert.equal(res.partial, false);
  assert.equal(res.shopifyAvailable, false);
  assert.equal(shopify.count(), 0, "Shopify is not read when the master read fails closed");
});

test("products builder throwing does not leak the raw error → master_error", async () => {
  const { client } = fakePagedClient({ products: { rows: [rawProduct()], throwAtCall: 1 } });
  const res = await loadShopifyCatalog(client, { project: PROJECTOR, shopify: fakeShopify({ products: [] }).reader });
  assert.equal(res.status, "master_error");
});

test("variant page error is non-fatal → status ok but partial true", async () => {
  const { client } = fakePagedClient({
    products: { rows: [rawProduct({ sku: "MK-1" })] },
    product_variants: { rows: [{ id: "v1", parent_product_id: "p1", sku: "V" }], failAtCall: 1 },
  });
  const res = await loadShopifyCatalog(client, {
    project: PROJECTOR,
    shopify: fakeShopify({ products: [shopProduct()] }).reader,
  });
  assert.equal(res.status, "ok");
  assert.equal(res.partial, true);
  // Variant rows were discarded → the product collapses to a single parent row.
  assert.equal(res.rows.length, 1);
  assert.equal(res.rows[0]!.masterVariantId, null);
});

// ── Shopify unavailable degrades safely ──────────────────────────────────────

test("Shopify error → shopify_unavailable, rows unknown, no orphans (never all-missing)", async () => {
  const { client } = fakePagedClient({ products: { rows: [rawProduct(), rawProduct({ id: "p2" })] }, product_variants: { rows: [] } });
  const res = await loadShopifyCatalog(client, {
    project: PROJECTOR,
    shopify: fakeShopify({ error: "TOKEN SECRET LEAK" }).reader,
  });

  assert.equal(res.status, "shopify_unavailable");
  assert.equal(res.shopifyAvailable, false);
  assert.deepEqual(res.orphanVariants, []);
  assert.equal(res.rows.length, 2);
  for (const row of res.rows) {
    assert.equal(row.presenceStatus, "unknown");
    assert.equal(row.matchStatus, "unknown");
    assert.equal(row.shopifyProductId, null);
  }
});

test("Shopify reader throwing → shopify_unavailable (no raw error surfaced)", async () => {
  const { client } = fakePagedClient({ products: { rows: [rawProduct()] }, product_variants: { rows: [] } });
  const res = await loadShopifyCatalog(client, {
    project: PROJECTOR,
    shopify: fakeShopify(() => {
      throw new Error("SHOPIFY BOOM SECRET");
    }).reader,
  });
  assert.equal(res.status, "shopify_unavailable");
  assert.equal(res.rows[0]!.matchStatus, "unknown");
});

test("Shopify returning no products array → shopify_unavailable", async () => {
  const { client } = fakePagedClient({ products: { rows: [rawProduct()] }, product_variants: { rows: [] } });
  const res = await loadShopifyCatalog(client, {
    project: PROJECTOR,
    shopify: fakeShopify({}).reader,
  });
  assert.equal(res.status, "shopify_unavailable");
});

test("empty Shopify store (available) → status ok, rows missing, no orphans", async () => {
  const { client } = fakePagedClient({ products: { rows: [rawProduct({ sku: "MK-9" })] }, product_variants: { rows: [] } });
  const res = await loadShopifyCatalog(client, { project: PROJECTOR, shopify: fakeShopify({ products: [] }).reader });
  assert.equal(res.status, "ok");
  assert.equal(res.shopifyAvailable, true);
  assert.equal(res.rows[0]!.presenceStatus, "missing");
  assert.deepEqual(res.orphanVariants, []);
});

// ── Classified unavailability reason (production incident 2026-08-23) ────────
//
// The store was frozen by Shopify billing and every authenticated Admin call
// was rejected, but the operator only saw the generic banner — the cause was
// swallowed. These tests pin the classification and its propagation. The RAW
// error string must never appear anywhere in the result.

test("classifyShopifyUnavailable maps the central client's fixed errors to categories", () => {
  assert.equal(classifyShopifyUnavailable("شوبي فاي غير مهيأ (SHOPIFY_STORE_DOMAIN)."), "not_configured");
  assert.equal(classifyShopifyUnavailable("شوبي فاي غير مربوط بعد — افتح /api/shopify/install لإتمام الربط."), "not_connected");
  assert.equal(classifyShopifyUnavailable("Shopify HTTP 402: Payment Required"), "store_unavailable");
  assert.equal(classifyShopifyUnavailable("Shopify HTTP 403: forbidden"), "store_unavailable");
  assert.equal(classifyShopifyUnavailable("This shop is unavailable for API access."), "store_unavailable");
  assert.equal(classifyShopifyUnavailable("Shopify HTTP 401: [API] Invalid API key or access token"), "auth_rejected");
  assert.equal(classifyShopifyUnavailable("fetch failed"), "error");
  assert.equal(classifyShopifyUnavailable(undefined), "error");
});

test("shopify_unavailable carries the CLASSIFIED reason — never the raw error text", async () => {
  const { client } = fakePagedClient({ products: { rows: [rawProduct()] }, product_variants: { rows: [] } });
  const res = await loadShopifyCatalog(client, {
    project: PROJECTOR,
    shopify: fakeShopify({ error: "Shopify HTTP 402: SECRET DETAIL tok_abc" }).reader,
  });
  assert.equal(res.status, "shopify_unavailable");
  assert.ok(res.status === "shopify_unavailable");
  assert.equal(res.reason, "store_unavailable");
  assert.ok(!JSON.stringify(res).includes("SECRET"), "raw error text never leaves the reader");
  assert.ok(!JSON.stringify(res).includes("tok_abc"), "no token fragment ever leaves the reader");
});

test("a throwing Shopify reader classifies as the generic 'error' reason", async () => {
  const { client } = fakePagedClient({ products: { rows: [rawProduct()] }, product_variants: { rows: [] } });
  const res = await loadShopifyCatalog(client, {
    project: PROJECTOR,
    shopify: fakeShopify(() => {
      throw new Error("BOOM");
    }).reader,
  });
  assert.equal(res.status, "shopify_unavailable");
  assert.ok(res.status === "shopify_unavailable");
  assert.equal(res.reason, "error");
});
