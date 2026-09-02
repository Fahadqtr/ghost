// Full catalog export — pure builder tests.
// node --conditions=react-server --experimental-strip-types --test lib/catalog-v2/full-catalog-export.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildFullCatalogSheets,
  columnWidths,
  fullCatalogFilename,
  IMAGES_HEADER,
  LISTINGS_HEADER,
  PRODUCTS_HEADER,
  shopifyNumericId,
  VARIANTS_HEADER,
  type FullCatalogInput,
} from "./full-catalog-export.ts";

const product = (over: Record<string, unknown> = {}) =>
  ({
    id: "p1", sku: "mk1", barcode: "0429766714844", name_en: "EN", name_ar: "ع",
    description_en: null, description_ar: null, brand_id: "b1", main_category: "Face Care",
    sub_category: null, price: 58, discount_price: null, cost: null, lifecycle_state: "ACTIVE",
    approval: "Approved", rejection_reason: null, stock_status: "In Stock", stock_quantity: null,
    image_url: "https://x/mk1.jpg", image_filename: "mk1.jpg", product_type: null, color: null,
    size: null, keywords_en: null, keywords_ar: null, is_featured: false, is_promoted: false,
    has_buy1get1: false, notes: null, snoonu_id: null, pure_seoul_id: null, pure_seoul_status: null,
    rafeeq_product_id: null, platform_status: null, created_at: "2026-01-01", updated_at: "2026-01-02",
    ...over,
  }) as never;

const base = (over: Partial<FullCatalogInput> = {}): FullCatalogInput => ({
  products: [product()],
  images: [],
  variants: [],
  listings: [],
  brands: [{ id: "b1", name: "Rhode" }],
  categories: [{ id: "c9", name: "Face Care" }],
  ...over,
});

test("every sheet starts with its header row", () => {
  const s = buildFullCatalogSheets(base());
  assert.deepEqual(s.products[0], PRODUCTS_HEADER.slice());
  assert.deepEqual(s.images[0], IMAGES_HEADER.slice());
  assert.deepEqual(s.variants[0], VARIANTS_HEADER.slice());
  assert.deepEqual(s.listings[0], LISTINGS_HEADER.slice());
});

test("nothing is filtered out — DRAFT, STOPPED, unapproved, PENDING, no barcode, no image", () => {
  const s = buildFullCatalogSheets(
    base({
      products: [
        product({ id: "a", sku: "mk1", lifecycle_state: "ACTIVE" }),
        product({ id: "b", sku: "mk2", lifecycle_state: "DRAFT", approval: null }),
        product({ id: "c", sku: "mk3", lifecycle_state: "STOPPED" }),
        product({ id: "d", sku: "PENDING-SNOONU-abc", barcode: null, image_url: null }),
      ],
    }),
  );
  assert.equal(s.products.length, 5); // header + 4
  assert.deepEqual(s.products.slice(1).map((r) => r[1]), ["mk1", "mk2", "mk3", "PENDING-SNOONU-abc"]);
});

test("every cell is a string so Excel cannot reformat a barcode or eat a leading zero", () => {
  const s = buildFullCatalogSheets(base());
  for (const sheet of [s.products, s.images, s.variants, s.listings]) {
    for (const row of sheet) for (const cell of row) assert.equal(typeof cell, "string");
  }
  assert.equal(s.products[1][2], "0429766714844"); // leading zero preserved
});

test("nulls become empty cells and are never dropped — row width stays constant", () => {
  const s = buildFullCatalogSheets(base({ products: [product({ description_en: null, notes: null })] }));
  assert.equal(s.products[1].length, PRODUCTS_HEADER.length);
  assert.equal(s.products[1][PRODUCTS_HEADER.indexOf("description_en")], "");
});

test("brand and category names/ids resolve from the lookup tables", () => {
  const s = buildFullCatalogSheets(base());
  assert.equal(s.products[1][PRODUCTS_HEADER.indexOf("brand")], "Rhode");
  assert.equal(s.products[1][PRODUCTS_HEADER.indexOf("brand_id")], "b1");
  assert.equal(s.products[1][PRODUCTS_HEADER.indexOf("category")], "Face Care");
  assert.equal(s.products[1][PRODUCTS_HEADER.indexOf("category_id")], "c9");
});

test("channel columns take the ACTIVE listing when archived history also exists", () => {
  const s = buildFullCatalogSheets(
    base({
      listings: [
        {
          id: "l-old", product_id: "p1", channel_key: "snoonu", storefront_key: "snoonu:malikas",
          external_product_id: "OLDSPI", external_variant_id: null, identity_type: "snoonu_spi",
          mapping_status: "archived", exported_sku: null, exported_barcode: null, variant_id: null,
          variant_sku: null, metadata: {}, created_at: null, updated_at: null,
        },
        {
          id: "l-new", product_id: "p1", channel_key: "snoonu", storefront_key: "snoonu:malikas",
          external_product_id: "LIVESPI", external_variant_id: null, identity_type: "snoonu_spi",
          mapping_status: "active", exported_sku: null, exported_barcode: null, variant_id: null,
          variant_sku: null, metadata: {}, created_at: null, updated_at: null,
        },
      ],
    }),
  );
  assert.equal(s.products[1][PRODUCTS_HEADER.indexOf("snoonu_spi")], "LIVESPI");
  assert.equal(s.products[1][PRODUCTS_HEADER.indexOf("snoonu_listing_id")], "l-new");
  assert.equal(s.products[1][PRODUCTS_HEADER.indexOf("snoonu_listing_active")], "TRUE");
  // …but the Channel Listings sheet keeps BOTH rows — never collapsed.
  assert.equal(s.listings.length, 3);
});

test("Channel Listings covers every channel, not just Snoonu", () => {
  const mk = (id: string, storefront: string) => ({
    id, product_id: "p1", channel_key: storefront.split(":")[0], storefront_key: storefront,
    external_product_id: "X", external_variant_id: null, identity_type: null, mapping_status: "active",
    exported_sku: null, exported_barcode: null, variant_id: null, variant_sku: null,
    metadata: null, created_at: null, updated_at: null,
  });
  const s = buildFullCatalogSheets(
    base({ listings: [mk("1", "snoonu:malikas"), mk("2", "shopify:malikas"), mk("3", "rafeeq:malikas"), mk("4", "snoonu:pure_seoul")] }),
  );
  assert.equal(s.listings.length, 5);
  const storefronts = s.listings.slice(1).map((r) => r[LISTINGS_HEADER.indexOf("storefront_key")]);
  assert.deepEqual(storefronts.sort(), ["rafeeq:malikas", "shopify:malikas", "snoonu:malikas", "snoonu:pure_seoul"]);
});

test("images sheet is raw and never deduplicated — two products sharing one URL keep both rows", () => {
  const img = (id: string, pid: string) => ({
    id, product_id: pid, url: "https://x/same.jpg", filename: "same.jpg",
    is_primary: true, sort_order: 0, created_at: null,
  });
  const s = buildFullCatalogSheets(
    base({
      products: [product({ id: "p1", sku: "mkA" }), product({ id: "p2", sku: "mkB" })],
      images: [img("i1", "p1"), img("i2", "p2")],
    }),
  );
  assert.equal(s.images.length, 3);
  assert.deepEqual(s.images.slice(1).map((r) => r[IMAGES_HEADER.indexOf("sku")]), ["mkA", "mkB"]);
});

test("images sheet flags whether a row matches products.image_url", () => {
  const s = buildFullCatalogSheets(
    base({
      products: [product({ id: "p1", image_url: "https://x/a.jpg" })],
      images: [
        { id: "i1", product_id: "p1", url: "https://x/a.jpg", filename: "a.jpg", is_primary: true, sort_order: 0, created_at: null },
        { id: "i2", product_id: "p1", url: "https://x/b.jpg", filename: "b.jpg", is_primary: false, sort_order: 1, created_at: null },
      ],
    }),
  );
  const col = IMAGES_HEADER.indexOf("matches_product_primary_image_url");
  assert.equal(s.images[1][col], "TRUE");
  assert.equal(s.images[2][col], "FALSE");
});

test("variants map color/size onto the option columns and carry the parent SKU", () => {
  const s = buildFullCatalogSheets(
    base({
      variants: [{
        id: "v1", parent_product_id: "p1", variant_name: "Toast", variant_name_en: "Toast",
        sku: "mk1-1", barcode: "999", color: "Toast", size: null, price: 239,
        stock_quantity: null, stock_status: "In Stock", created_at: null,
      }],
    }),
  );
  const r = s.variants[1];
  assert.equal(r[VARIANTS_HEADER.indexOf("parent_sku")], "mk1");
  assert.equal(r[VARIANTS_HEADER.indexOf("option1_name")], "color");
  assert.equal(r[VARIANTS_HEADER.indexOf("option1_value")], "Toast");
  assert.equal(r[VARIANTS_HEADER.indexOf("option2_name")], ""); // no size on this variant
});

test("has_variants / counts reflect the joined rows", () => {
  const s = buildFullCatalogSheets(
    base({
      images: [{ id: "i1", product_id: "p1", url: "u", filename: "f", is_primary: true, sort_order: 0, created_at: null }],
      variants: [{
        id: "v1", parent_product_id: "p1", variant_name: null, variant_name_en: null, sku: null,
        barcode: null, color: null, size: null, price: null, stock_quantity: null, stock_status: null, created_at: null,
      }],
    }),
  );
  assert.equal(s.products[1][PRODUCTS_HEADER.indexOf("product_images_count")], "1");
  assert.equal(s.products[1][PRODUCTS_HEADER.indexOf("has_variants")], "TRUE");
  assert.equal(s.products[1][PRODUCTS_HEADER.indexOf("variants_count")], "1");
});

test("shopify gid is kept verbatim and also split into its numeric id", () => {
  assert.equal(shopifyNumericId("gid://shopify/Product/9483898290414"), "9483898290414");
  assert.equal(shopifyNumericId("6a74bbd92503fb82f31f2866"), "6a74bbd92503fb82f31f2866");
  assert.equal(shopifyNumericId(null), "");
});

test("filename follows malikas-full-catalog-YYYY-MM-DD-HHmm.xlsx", () => {
  assert.equal(fullCatalogFilename(new Date("2026-09-02T07:05:00Z")), "malikas-full-catalog-2026-09-02-0705.xlsx");
});

test("column widths are bounded so a long description cannot blow the sheet", () => {
  const w = columnWidths([["a", "b"], ["x".repeat(500), "y"]]);
  assert.ok(w[0].wch <= 46);
  assert.ok(w[1].wch >= 10);
});
