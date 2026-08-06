// Tests for similar-product card hydration (Phase UI.5, card revision).
// PURE — scripted fake client; proves the browser payload is a whitelisted
// card set, never the catalog.
// Run: node --conditions=react-server --experimental-strip-types --test lib/products/similar-products-read.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { loadSimilarProductCards, toSimilarProductCards } from "./similar-products-read.ts";
import type { DuplicateProductMatch } from "./duplicate-detect.ts";

const MATCHES: DuplicateProductMatch[] = [
  { productId: "p-exact", level: "exact", reasons: ["same_sku", "same_brand"], score: 120 },
  { productId: "p-sim", level: "similar", reasons: ["similar_name", "same_size"], score: 55 },
];

const PRODUCT_ROWS: Record<string, unknown>[] = [
  {
    id: "p-exact",
    sku: "mk10",
    barcode: "4006381333931",
    name_ar: "سيروم كوزركس",
    name_en: "Cosrx Essence",
    brand_id: "b1",
    main_category: "Korean Skincare",
    size: "96ml",
    price: 120,
    discount_price: 99,
    image_url: "https://x.supabase.co/storage/v1/object/public/product-images/mk10.jpg",
    approval: " Approved ",
    description_ar: "وصف",
    description_en: "desc",
    // hostile extras that must NOT survive projection:
    stock_quantity: 55,
    shopify_gid: "gid://shopify/Product/1",
  },
  { id: "p-sim", sku: "mk11", barcode: null, name_ar: null, name_en: "Rhode Tint", brand_id: null, main_category: null, size: null, price: null, discount_price: null, image_url: null, approval: "Rejected", description_ar: null, description_en: null },
];

const CARD_KEYS = [
  "approved", "barcode", "brand", "category", "descriptionAr", "descriptionEn",
  "detailHref", "discountPrice", "id", "imageUrl", "level", "nameAr", "nameEn",
  "price", "reasons", "size", "sku", "variantCount",
];

test("projection: whitelisted card fields ONLY — hostile row fields never pass through", () => {
  const cards = toSimilarProductCards(MATCHES, PRODUCT_ROWS, ["p-exact", "p-exact"], [{ id: "b1", name: "Cosrx" }]);
  assert.equal(cards.length, 2);
  for (const c of cards) {
    assert.deepEqual(Object.keys(c).sort(), CARD_KEYS, "no extra keys");
  }
  const s = JSON.stringify(cards);
  assert.ok(!s.includes("gid://"), "no Shopify GID");
  assert.ok(!s.includes("stock"), "no stock field");
});

test("projection: fields map correctly — brand resolved, approval normalized, counts counted", () => {
  const [c] = toSimilarProductCards(MATCHES, PRODUCT_ROWS, ["p-exact", "p-exact"], [{ id: "b1", name: "Cosrx" }]);
  assert.equal(c.id, "p-exact");
  assert.equal(c.level, "exact");
  assert.equal(c.brand, "Cosrx");
  assert.equal(c.approved, true, "' Approved ' normalizes to approved");
  assert.equal(c.variantCount, 2);
  assert.equal(c.price, 120);
  assert.equal(c.discountPrice, 99);
  assert.deepEqual(c.reasons, ["same_sku", "same_brand"]);
});

test("projection: detailHref uses the REAL encoded product id — never name or sku", () => {
  const cards = toSimilarProductCards(
    [{ productId: "a/b?c", level: "similar", reasons: ["similar_name"], score: 40 }],
    [{ id: "a/b?c", sku: "mk50", name_en: "X Y" }],
    [],
    [],
  );
  assert.equal(cards[0].detailHref, `/v2/catalog/${encodeURIComponent("a/b?c")}`);
  assert.ok(!cards[0].detailHref.includes("mk50"));
});

test("projection: missing image stays null (placeholder is the UI's job) and missing product rows are dropped", () => {
  const cards = toSimilarProductCards(MATCHES, [PRODUCT_ROWS[1]], [], []);
  assert.equal(cards.length, 1, "match without a loaded row is dropped");
  assert.equal(cards[0].id, "p-sim");
  assert.equal(cards[0].imageUrl, null);
  assert.equal(cards[0].approved, false);
});

test("projection: order preserved, duplicates by id collapsed, limit enforced", () => {
  const many: DuplicateProductMatch[] = [
    { productId: "p-sim", level: "similar", reasons: ["similar_name"], score: 40 },
    { productId: "p-sim", level: "similar", reasons: ["similar_name"], score: 40 },
    { productId: "p-exact", level: "exact", reasons: ["same_sku"], score: 100 },
  ];
  const cards = toSimilarProductCards(many, PRODUCT_ROWS, [], [], 1);
  assert.equal(cards.length, 1, "limit enforced");
  assert.equal(cards[0].id, "p-sim", "input order preserved (sorting is the detector's job)");
});

// ── loader with a fake client ────────────────────────────────────────────────

function makeClient(over: Record<string, unknown> = {}) {
  const o = {
    products: { data: PRODUCT_ROWS as unknown[], error: null as unknown },
    variants: { data: [{ parent_product_id: "p-exact" }] as unknown[], error: null as unknown },
    brands: { data: [{ id: "b1", name: "Cosrx" }] as unknown[], error: null as unknown },
    ...over,
  };
  const filters: string[] = [];
  const client = {
    from(table: string) {
      return {
        select(_c: string) {
          return {
            filter(_col: string, _op: string, value: string) {
              filters.push(`${table}:${value}`);
              const out = table === "products" ? o.products : table === "product_variants" ? o.variants : o.brands;
              return Object.assign(Promise.resolve(out), {
                limit: (_n: number) => Promise.resolve(out),
              });
            },
          };
        },
      };
    },
  };
  return { client, filters };
}

test("loader: queries ONLY the matched ids (never the whole catalog) and returns hydrated cards", async () => {
  const { client, filters } = makeClient();
  const res = await loadSimilarProductCards(client, MATCHES, 7);
  assert.equal(res.status, "ok");
  assert.equal(res.cards.length, 2);
  assert.equal(res.total, 7, "total passes through for the '+N more' note");
  const productFilter = filters.find((f) => f.startsWith("products:"));
  assert.ok(productFilter?.includes("p-exact") && productFilter?.includes("p-sim"), "id-list filter");
});

test("loader: a read failure degrades to an empty card list — the level banner still renders", async () => {
  const { client } = makeClient({ products: { data: null, error: { message: "boom" } } });
  const res = await loadSimilarProductCards(client, MATCHES, 2);
  assert.equal(res.status, "ok");
  assert.deepEqual(res.cards, []);
  assert.equal(res.total, 2);
});

test("loader: no matches -> no queries at all", async () => {
  const { client, filters } = makeClient();
  const res = await loadSimilarProductCards(client, [], 0);
  assert.deepEqual(res.cards, []);
  assert.equal(filters.length, 0);
});
