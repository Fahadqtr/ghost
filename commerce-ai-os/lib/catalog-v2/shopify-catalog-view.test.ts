// Tests for the Malikas V2 Shopify Catalog view + matching layer (Phase UI.3B).
// PURE tests only — no database, no network, no Shopify, no Supabase.
// Run: node --conditions=react-server --experimental-strip-types --test lib/catalog-v2/shopify-catalog-view.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  projectShopifyCatalog,
  normalizeSku,
  normalizeBarcode,
  normalizeShopifyStatus,
  getMatchStatusLabel,
  getPresenceStatusLabel,
  getShopifyStatusLabel,
  getOrphanReasonLabel,
  type ShopifyProductInput,
} from "./shopify-catalog-view.ts";

// ── Builders ─────────────────────────────────────────────────────────────────

function rawProduct(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "p1",
    sku: "MK-1",
    barcode: "BAR-1",
    name_ar: "منتج",
    name_en: "Product",
    price: 10,
    image_url: "https://img/1.jpg",
    ...over,
  };
}
function rawVariant(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "v1", parent_product_id: "p1", sku: "MKV-1", barcode: "VBAR-1", price: 12, ...over };
}
function shopVariant(over: Partial<ShopifyProductInput["variants"][number]> = {}): ShopifyProductInput["variants"][number] {
  return { id: "gid://variant/1", sku: "MK-1", barcode: "BAR-1", inventoryItemId: "gid://inv/1", ...over };
}
function shopProduct(over: Partial<ShopifyProductInput> = {}): ShopifyProductInput {
  return {
    id: "gid://product/1",
    title: "Shopify Product",
    status: "ACTIVE",
    imageUrl: "https://shop/img.jpg",
    variants: [shopVariant()],
    ...over,
  };
}

// ── Normalization ────────────────────────────────────────────────────────────

test("normalizeSku: trims + lowercases; empty/whitespace/non-string → null", () => {
  assert.equal(normalizeSku("  AbC-1 "), "abc-1");
  assert.equal(normalizeSku("SKU"), "sku");
  assert.equal(normalizeSku(""), null);
  assert.equal(normalizeSku("   "), null);
  assert.equal(normalizeSku(null), null);
});

test("normalizeBarcode: trims only (case preserved); empty → null", () => {
  assert.equal(normalizeBarcode("  AbC123 "), "AbC123");
  assert.equal(normalizeBarcode(""), null);
  assert.equal(normalizeBarcode("   "), null);
  assert.equal(normalizeBarcode(null), null);
});

test("normalizeShopifyStatus: fixed enum; unknown for anything else", () => {
  assert.equal(normalizeShopifyStatus("ACTIVE"), "active");
  assert.equal(normalizeShopifyStatus("draft"), "draft");
  assert.equal(normalizeShopifyStatus("Archived"), "archived");
  assert.equal(normalizeShopifyStatus("WEIRD"), "unknown");
  assert.equal(normalizeShopifyStatus(""), "unknown");
});

// ── Master-side row shaping ──────────────────────────────────────────────────

test("product without variants → exactly one matchable row (masterVariantId null)", () => {
  const res = projectShopifyCatalog([rawProduct()], [], []);
  assert.equal(res.rows.length, 1);
  assert.equal(res.rows[0]!.masterProductId, "p1");
  assert.equal(res.rows[0]!.masterVariantId, null);
  assert.equal(res.rows[0]!.sku, "MK-1");
});

test("product WITH variants → one row per variant and NO extra parent row", () => {
  const product = rawProduct();
  const variants = [
    rawVariant({ id: "v1", sku: "V-A" }),
    rawVariant({ id: "v2", sku: "V-B" }),
  ];
  const res = projectShopifyCatalog([product], variants, []);
  assert.equal(res.rows.length, 2, "two variant rows, parent not counted as an extra sellable row");
  assert.deepEqual(
    res.rows.map((r) => r.masterVariantId).sort(),
    ["v1", "v2"],
  );
  // Every row carries the parent product identity + name/image.
  for (const r of res.rows) {
    assert.equal(r.masterProductId, "p1");
    assert.equal(r.nameAr, "منتج");
    assert.equal(r.imageUrl, "https://img/1.jpg");
  }
});

test("variant price falls back to the product price when the variant has none", () => {
  const res = projectShopifyCatalog([rawProduct({ price: 25 })], [rawVariant({ price: null })], []);
  assert.equal(res.rows[0]!.price, 25);
});

test("malformed product / variant rows are skipped, never coerced", () => {
  const res = projectShopifyCatalog(
    [rawProduct(), { id: 123 }, null, "x"],
    [rawVariant(), { parent_product_id: "p1", id: 9 }],
    [],
  );
  // Only the valid product yields rows; the numeric-id product is dropped.
  const ids = res.rows.map((r) => r.masterProductId);
  assert.deepEqual([...new Set(ids)], ["p1"]);
});

// ── Matching: SKU ────────────────────────────────────────────────────────────

test("unique SKU match → matched_sku with Shopify ids attached (case-insensitive)", () => {
  const res = projectShopifyCatalog(
    [rawProduct({ sku: "MK-1" })],
    [],
    [shopProduct({ variants: [shopVariant({ id: "gid://variant/9", sku: "mk-1", inventoryItemId: "gid://inv/9" })] })],
  );
  const row = res.rows[0]!;
  assert.equal(row.matchStatus, "matched_sku");
  assert.equal(row.presenceStatus, "present");
  assert.equal(row.shopifyVariantId, "gid://variant/9");
  assert.equal(row.shopifyProductId, "gid://product/1");
  assert.equal(row.shopifyInventoryItemId, "gid://inv/9");
  assert.equal(row.shopifyStatus, "active");
  assert.equal(row.matchReason, "unique SKU match");
});

test("duplicate SKU across Shopify variants → ambiguous, Shopify ids withheld", () => {
  const res = projectShopifyCatalog(
    [rawProduct({ sku: "DUP" })],
    [],
    [
      shopProduct({ id: "gid://product/1", variants: [shopVariant({ id: "gid://variant/1", sku: "dup" })] }),
      shopProduct({ id: "gid://product/2", variants: [shopVariant({ id: "gid://variant/2", sku: "DUP" })] }),
    ],
  );
  const row = res.rows[0]!;
  assert.equal(row.matchStatus, "ambiguous");
  assert.equal(row.presenceStatus, "present");
  assert.equal(row.shopifyProductId, null);
  assert.equal(row.shopifyVariantId, null);
  assert.equal(row.shopifyInventoryItemId, null);
  assert.equal(row.matchReason, "multiple Shopify variants share this SKU");
});

// ── Matching: barcode fallback only when SKU found nothing ────────────────────

test("barcode used ONLY when SKU produced no match → matched_barcode", () => {
  const res = projectShopifyCatalog(
    [rawProduct({ sku: "NO-SUCH-SKU", barcode: "BAR-9" })],
    [],
    [shopProduct({ variants: [shopVariant({ id: "gid://variant/7", sku: "OTHER", barcode: "BAR-9" })] })],
  );
  const row = res.rows[0]!;
  assert.equal(row.matchStatus, "matched_barcode");
  assert.equal(row.shopifyVariantId, "gid://variant/7");
  assert.equal(row.matchReason, "unique barcode match (no SKU match)");
});

test("barcode is NOT consulted when the SKU already matched uniquely", () => {
  const res = projectShopifyCatalog(
    [rawProduct({ sku: "MK-1", barcode: "BAR-9" })],
    [],
    [
      shopProduct({ id: "gid://product/1", variants: [shopVariant({ id: "gid://variant/1", sku: "MK-1", barcode: "ZZZ" })] }),
      shopProduct({ id: "gid://product/2", variants: [shopVariant({ id: "gid://variant/2", sku: "X", barcode: "BAR-9" })] }),
    ],
  );
  assert.equal(res.rows[0]!.matchStatus, "matched_sku");
  assert.equal(res.rows[0]!.shopifyVariantId, "gid://variant/1");
});

test("ambiguous SKU does NOT fall through to a unique barcode — stays ambiguous", () => {
  const res = projectShopifyCatalog(
    [rawProduct({ sku: "DUP", barcode: "BAR-U" })],
    [],
    [
      shopProduct({ id: "gid://product/1", variants: [shopVariant({ id: "gid://variant/1", sku: "DUP", barcode: "b1" })] }),
      shopProduct({ id: "gid://product/2", variants: [shopVariant({ id: "gid://variant/2", sku: "DUP", barcode: "b2" })] }),
      shopProduct({ id: "gid://product/3", variants: [shopVariant({ id: "gid://variant/3", sku: "SOLO", barcode: "BAR-U" })] }),
    ],
  );
  assert.equal(res.rows[0]!.matchStatus, "ambiguous");
});

test("duplicate barcode (no SKU match) → ambiguous, ids withheld", () => {
  const res = projectShopifyCatalog(
    [rawProduct({ sku: null, barcode: "BAR-D" })],
    [],
    [
      shopProduct({ id: "gid://product/1", variants: [shopVariant({ id: "gid://variant/1", sku: "a", barcode: "BAR-D" })] }),
      shopProduct({ id: "gid://product/2", variants: [shopVariant({ id: "gid://variant/2", sku: "b", barcode: "BAR-D" })] }),
    ],
  );
  const row = res.rows[0]!;
  assert.equal(row.matchStatus, "ambiguous");
  assert.equal(row.shopifyVariantId, null);
  assert.equal(row.matchReason, "multiple Shopify variants share this barcode");
});

test("barcode is case-sensitive: differing case does NOT match", () => {
  const res = projectShopifyCatalog(
    [rawProduct({ sku: null, barcode: "AbC" })],
    [],
    [shopProduct({ variants: [shopVariant({ sku: "", barcode: "abc" })] })],
  );
  assert.equal(res.rows[0]!.matchStatus, "unmatched");
});

// ── Matching: unmatched / empty identities ───────────────────────────────────

test("no SKU or barcode match → unmatched + presence missing", () => {
  const res = projectShopifyCatalog(
    [rawProduct({ sku: "NONE", barcode: "NONE" })],
    [],
    [shopProduct({ variants: [shopVariant({ sku: "other", barcode: "other" })] })],
  );
  const row = res.rows[0]!;
  assert.equal(row.matchStatus, "unmatched");
  assert.equal(row.presenceStatus, "missing");
  assert.equal(row.shopifyProductId, null);
  assert.equal(row.matchReason, "no Shopify SKU or barcode match");
});

test("empty sku AND empty barcode → unmatched (never matches empty Shopify identities)", () => {
  const res = projectShopifyCatalog(
    [rawProduct({ sku: "", barcode: "" })],
    [],
    [shopProduct({ variants: [shopVariant({ sku: "", barcode: "" })] })],
  );
  assert.equal(res.rows[0]!.matchStatus, "unmatched");
});

// ── Shopify unavailable ──────────────────────────────────────────────────────

test("Shopify unavailable (null) → every row unknown, no ids, no orphans", () => {
  const res = projectShopifyCatalog([rawProduct(), rawProduct({ id: "p2" })], [], null);
  assert.equal(res.shopifyAvailable, false);
  assert.equal(res.orphanVariants.length, 0);
  assert.equal(res.rows.length, 2);
  for (const row of res.rows) {
    assert.equal(row.presenceStatus, "unknown");
    assert.equal(row.matchStatus, "unknown");
    assert.equal(row.shopifyProductId, null);
    assert.equal(row.shopifyVariantId, null);
    assert.equal(row.shopifyInventoryItemId, null);
    assert.equal(row.shopifyStatus, "unknown");
    assert.equal(row.matchReason, null);
  }
});

test("empty Shopify store (available) → rows missing, no orphans, available true", () => {
  const res = projectShopifyCatalog([rawProduct()], [], []);
  assert.equal(res.shopifyAvailable, true);
  assert.equal(res.rows[0]!.presenceStatus, "missing");
  assert.equal(res.orphanVariants.length, 0);
});

// ── Orphans ──────────────────────────────────────────────────────────────────

test("Shopify variant with no Malikas match → orphan (no_master_match)", () => {
  const res = projectShopifyCatalog(
    [rawProduct({ sku: "MK-1" })],
    [],
    [
      shopProduct({ id: "gid://product/1", variants: [shopVariant({ id: "gid://variant/1", sku: "MK-1" })] }),
      shopProduct({ id: "gid://product/2", variants: [shopVariant({ id: "gid://variant/2", sku: "LONELY", barcode: "LB" })] }),
    ],
  );
  assert.equal(res.orphanVariants.length, 1);
  const o = res.orphanVariants[0]!;
  assert.equal(o.shopifyVariantId, "gid://variant/2");
  assert.equal(o.reason, "no_master_match");
  assert.equal(o.sku, "LONELY");
  assert.equal(o.status, "active");
});

test("a cleanly attributed Shopify variant is NOT listed as an orphan", () => {
  const res = projectShopifyCatalog(
    [rawProduct({ sku: "MK-1" })],
    [],
    [shopProduct({ variants: [shopVariant({ id: "gid://variant/1", sku: "MK-1" })] })],
  );
  assert.equal(res.rows[0]!.matchStatus, "matched_sku");
  assert.equal(res.orphanVariants.length, 0);
});

test("duplicate-identity Shopify variants → orphans (duplicate_identity), even with a master collision", () => {
  const res = projectShopifyCatalog(
    [rawProduct({ sku: "DUP" })],
    [],
    [
      shopProduct({ id: "gid://product/1", variants: [shopVariant({ id: "gid://variant/1", sku: "DUP" })] }),
      shopProduct({ id: "gid://product/2", variants: [shopVariant({ id: "gid://variant/2", sku: "DUP" })] }),
    ],
  );
  assert.equal(res.rows[0]!.matchStatus, "ambiguous");
  assert.equal(res.orphanVariants.length, 2);
  for (const o of res.orphanVariants) assert.equal(o.reason, "duplicate_identity");
});

test("duplicate-identity precedence over no-master-match", () => {
  const res = projectShopifyCatalog(
    [], // no master rows at all
    [],
    [
      shopProduct({ id: "gid://product/1", variants: [shopVariant({ id: "gid://variant/1", sku: "SHARED" })] }),
      shopProduct({ id: "gid://product/2", variants: [shopVariant({ id: "gid://variant/2", sku: "SHARED" })] }),
    ],
  );
  assert.equal(res.orphanVariants.length, 2);
  for (const o of res.orphanVariants) assert.equal(o.reason, "duplicate_identity");
});

test("a variant matched by barcode is attributed (not an orphan)", () => {
  const res = projectShopifyCatalog(
    [rawProduct({ sku: null, barcode: "BAR-1" })],
    [],
    [shopProduct({ variants: [shopVariant({ id: "gid://variant/1", sku: "", barcode: "BAR-1" })] })],
  );
  assert.equal(res.rows[0]!.matchStatus, "matched_barcode");
  assert.equal(res.orphanVariants.length, 0);
});

// ── PII / scope safety of the projected shape ────────────────────────────────

test("projected rows expose NO stock quantity / order / customer fields", () => {
  const res = projectShopifyCatalog([rawProduct({ sku: "MK-1" })], [], [shopProduct({ variants: [shopVariant({ sku: "MK-1" })] })]);
  const row = res.rows[0]! as Record<string, unknown>;
  for (const banned of ["inventoryQuantity", "stock", "stock_quantity", "quantity", "order", "customer", "price_raw", "compareAtPrice"]) {
    assert.equal(Object.hasOwn(row, banned), false, `row must not expose ${banned}`);
  }
  // inventory item IDENTITY is allowed; a stock number is not.
  assert.equal(typeof row.shopifyInventoryItemId, "string");
});

test("inputs are not mutated by projection", () => {
  const product = rawProduct();
  const variant = rawVariant();
  const shop = shopProduct();
  const before = JSON.stringify({ product, variant, shop });
  projectShopifyCatalog([product], [variant], [shop]);
  assert.equal(JSON.stringify({ product, variant, shop }), before);
});

// ── Fixed labels (prototype-safe; never reflect raw text) ─────────────────────

test("status labels are fixed and prototype-safe", () => {
  assert.equal(getMatchStatusLabel("matched_sku"), "مطابق (SKU)");
  assert.equal(getMatchStatusLabel("unknown"), "غير معروف");
  assert.equal(getPresenceStatusLabel("present"), "موجود في Shopify");
  assert.equal(getShopifyStatusLabel("archived"), "مؤرشف");
  assert.equal(getOrphanReasonLabel("duplicate_identity"), "هوية مكررة في Shopify");
  // Prototype-pollution / unknown keys fall back, never throw.
  assert.equal(getMatchStatusLabel("__proto__" as never), "غير معروف");
  assert.equal(getMatchStatusLabel("toString" as never), "غير معروف");
  assert.equal(getShopifyStatusLabel("constructor" as never), "غير معروف");
});

// ── Source safety scan: view file ────────────────────────────────────────────

function strip(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

test("view source: pure, DB-free, no writes/RPC/Shopify-mutations/coercion/any", () => {
  const src = strip(readFileSync(new URL("./shopify-catalog-view.ts", import.meta.url), "utf8"));
  for (const [re, msg] of [
    [/\bfetch\s*\(/, "fetch("],
    [/\.rpc\s*\(/, ".rpc("],
    [/\.insert\s*\(/, ".insert("],
    [/\.update\s*\(/, ".update("],
    [/\.upsert\s*\(/, ".upsert("],
    [/\.delete\s*\(/, ".delete("],
    [/productCreate/, "productCreate"],
    [/productUpdate/, "productUpdate"],
    [/productVariantsBulkUpdate/, "productVariantsBulkUpdate"],
    [/inventoryAdjust/, "inventoryAdjust"],
    [/inventorySet/, "inventorySet"],
    [/createAdminClient/, "createAdminClient"],
    [/service_role/, "service_role"],
    [/process\.env/, "process.env"],
    [/console\./, "console."],
    [/server-only/, "server-only"],
    [/supabase/i, "supabase"],
    [/from\s+["']next/, "next import"],
    [/\bString\s*\(/, "String("],
    [/Date\.now/, "Date.now"],
    [/:\s*any\b/, ": any"],
    [/\bas\s+any\b/, "as any"],
    [/select\(\s*["']\*["']\s*\)/, 'select("*")'],
    // never reads the Shopify stock quantity
    [/inventoryQuantity/, "inventoryQuantity"],
    [/stock_quantity/, "stock_quantity"],
  ] as const) {
    assert.ok(!re.test(src), `forbidden in view source: ${msg}`);
  }
});

// ── Source safety scan: read layer ───────────────────────────────────────────

test("read source: SELECT-only, no writes/RPC/Shopify-mutations/admin/env/logging/select(*)", () => {
  const src = strip(readFileSync(new URL("./shopify-catalog-read.ts", import.meta.url), "utf8"));
  for (const [re, msg] of [
    [/\.rpc\s*\(/, ".rpc("],
    [/\.insert\s*\(/, ".insert("],
    [/\.update\s*\(/, ".update("],
    [/\.upsert\s*\(/, ".upsert("],
    [/\.delete\s*\(/, ".delete("],
    [/productCreate/, "productCreate"],
    [/productUpdate/, "productUpdate"],
    [/productVariantsBulkUpdate/, "productVariantsBulkUpdate"],
    [/inventoryAdjust/, "inventoryAdjust"],
    [/inventorySet/, "inventorySet"],
    [/createAdminClient/, "createAdminClient"],
    [/service_role/, "service_role"],
    [/process\.env/, "process.env"],
    [/console\./, "console."],
    [/dangerouslySetInnerHTML/, "dangerouslySetInnerHTML"],
    [/select\(\s*["']\*["']\s*\)/, 'select("*")'],
    [/:\s*any\b/, ": any"],
    [/\bas\s+any\b/, "as any"],
    // never reads inventory stock quantity, even though identity is allowed
    [/inventoryQuantity/, "inventoryQuantity"],
    [/stock_quantity/, "stock_quantity"],
  ] as const) {
    assert.ok(!re.test(src), `forbidden in read source: ${msg}`);
  }
  // reads ONLY the catalog tables — no inventory/channel/platform/order tables
  for (const table of [
    "inventory",
    "channel_products",
    "channel_variant_mappings",
    "channels",
    "platform_status",
    "orders",
    "talabat_orders",
    "shopify_synced_orders",
  ]) {
    assert.ok(!new RegExp(`["']${table}["']`).test(src), `read must not reference table ${table}`);
  }
  assert.ok(/["']products["']/.test(src), "reads products");
  assert.ok(/["']product_variants["']/.test(src), "reads product_variants");
  // The Shopify read is the existing READ function only (no mutation helpers).
  assert.ok(/fetchAllShopifyProducts/.test(src), "calls the existing Shopify read");
  assert.ok(/server-only/.test(src), "read layer is server-only");
});
