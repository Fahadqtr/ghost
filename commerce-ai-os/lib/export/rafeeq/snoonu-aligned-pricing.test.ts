// STEP 47 — the APP Rafeeq FULL export must price to the Snoonu master.
//
// Proves the policy through the REAL certified engine (buildRafeeqPreview), not
// a reimplementation: fixtures carry the actual canonical list/discount/variant
// prices, and the assertions are the owner-specified Snoonu selling prices.
//
// The literal prices below are TEST EXPECTATIONS, never product logic — the
// exporter derives every price from the data it is given.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildRafeeqPreview,
  rafeeqExportDiscountPrice,
  RAFEEQ_SNOONU_ALIGNED_PRICING,
  type RafeeqPreviewProduct,
} from "./preview.ts";

const strip = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** Build a product the way preview.server.ts does — through the policy seam. */
function product(over: Partial<RafeeqPreviewProduct> & { sku: string }): RafeeqPreviewProduct {
  return {
    id: `id-${over.sku}`,
    barcode: "1234567890123",
    nameEn: `EN ${over.sku}`,
    nameAr: `ع ${over.sku}`,
    category: "Makeup",
    price: null,
    // EXACTLY how the reader now feeds the engine.
    discountPrice: rafeeqExportDiscountPrice(over.discountPrice ?? null),
    descriptionEn: "d", descriptionAr: "و",
    imageUrl: `https://example.test/${over.sku}.jpg`,
    imageFilename: `${over.sku}.jpg`,
    galleryImageUrls: [], imageCount: 1,
    variants: [],
    ...over,
    discountPrice: rafeeqExportDiscountPrice(over.discountPrice ?? null),
  };
}
const rowsOf = (...p: RafeeqPreviewProduct[]) => buildRafeeqPreview({ products: p }).rows;
const bySku = (rs: ReturnType<typeof rowsOf>, sku: string) => rs.find((r) => r.sku === sku)!;

// ── 1. the 15 discount-price products export at the SNOONU price ─────────────

/** [sku, canonical list (= Snoonu selling price), canonical discount_price] */
const DISCOUNTED: readonly [string, number, number][] = [
  ["mk1256", 589.00, 235.50], ["mk1196", 412.00, 123.50], ["mk957", 400.00, 160.00],
  ["mk1253", 400.00, 120.00], ["mk1252", 379.00, 151.50], ["mk1461", 341.75, 102.50],
  ["mk1201", 331.50, 132.50], ["mk958", 320.00, 160.00], ["mk1568", 309.00, 92.75],
  ["mk1204", 306.00, 126.50], ["mk1255", 360.00, 144.00], ["mk1100", 250.00, 87.50],
  ["mk1547", 241.00, 72.25], ["mk1549", 219.00, 87.50], ["mk1278", 146.00, 47.00],
];

test("all 15 discount-price products export at the Snoonu selling price", () => {
  const rows = rowsOf(...DISCOUNTED.map(([sku, list, disc]) =>
    product({ sku, price: list, discountPrice: disc })));
  assert.equal(rows.length, 15);
  for (const [sku, list] of DISCOUNTED) {
    const r = bySku(rows, sku);
    assert.equal(r.price, list, `${sku} must export the Snoonu price ${list}`);
    assert.equal(r.priceOnSelection, false, `${sku} is a simple product`);
  }
});

test("discount_price leakage is ZERO — no product exports its discount", () => {
  const rows = rowsOf(...DISCOUNTED.map(([sku, list, disc]) =>
    product({ sku, price: list, discountPrice: disc })));
  const leaks = rows.filter((r) => DISCOUNTED.some(([sku, , disc]) => r.sku === sku && r.price === disc));
  assert.deepEqual(leaks.map((r) => r.sku), [], "a discount price reached the export");
});

// ── 2. PRICE ON SELECTION products keep the certified encoding ───────────────

/** Real canonical option prices for the five differing-price products. */
const ON_SELECTION: readonly [string, number, number[]][] = [
  ["mk1121", 69.00, [68.00, 69.00]],
  ["mk995", 158.00, [158.00, 158.00, 158.00, 178.00, 178.00]],
  ["mk1161", 68.00, [69.00, 69.75, 69.75, 68.00, 68.00, 68.00]],
  ["mk1122", 65.00, [67.00, 69.50, 68.00, 65.00, 69.00]],
  ["mk1597", 18.00, [15.00, 48.00]],
];

test("the 5 differing-option products still export PRICE ON SELECTION with full option prices", () => {
  for (const [sku, parent, prices] of ON_SELECTION) {
    const r = bySku(rowsOf(product({
      sku, price: parent,
      variants: prices.map((p, i) => ({ id: `${sku}-v${i}`, sku: `${sku}-${i}`, barcode: null,
                                        nameEn: null, nameAr: `opt${i}`, price: p })),
    })), sku);
    assert.equal(r.priceOnSelection, true, `${sku} must be PRICE ON SELECTION`);
    assert.equal(r.price, null, `${sku} carries the sentinel, not a number`);
    assert.deepEqual(r.options.map((o) => o.effectivePrice).sort((a, b) => (a ?? 0) - (b ?? 0)),
                     [...prices].sort((a, b) => a - b),
                     `${sku} options must carry their FULL prices, never deltas`);
  }
});

// ── 3. uniform-option products export the real purchasable option price ──────

/** [sku, canonical parent "from" price, the uniform option price, n options] */
const UNIFORM: readonly [string, number, number, number][] = [
  ["mk1195", 95.00, 115.00, 10],
  ["mk1674", 189.00, 196.00, 3],
  ["mk998", 32.00, 38.00, 4],
];

test("the 3 uniform-option products export the ACTUAL option price, not the parent display price", () => {
  for (const [sku, parent, opt, n] of UNIFORM) {
    const r = bySku(rowsOf(product({
      sku, price: parent,
      variants: Array.from({ length: n }, (_, i) => ({ id: `${sku}-v${i}`, sku: `${sku}-${i}`,
        barcode: null, nameEn: null, nameAr: `opt${i}`, price: opt })),
    })), sku);
    assert.equal(r.priceOnSelection, false, `${sku} options are uniformly priced`);
    assert.equal(r.price, opt, `${sku} must export ${opt} (what a customer pays), not ${parent}`);
    assert.equal(r.optionCount, n);
  }
});

test("option pricing is unaffected by the policy — a variant's own price still wins", () => {
  // Even with a discount present, the option price governs.
  const r = bySku(rowsOf(product({
    sku: "mkopt", price: 100, discountPrice: 10,
    variants: [{ id: "v1", sku: "mkopt-1", barcode: null, nameEn: null, nameAr: "a", price: 77 },
               { id: "v2", sku: "mkopt-2", barcode: null, nameEn: null, nameAr: "b", price: 77 }],
  })), "mkopt");
  assert.equal(r.price, 77);
});

// ── 4. everything else is unchanged ──────────────────────────────────────────

test("a simple product with no discount exports its price unchanged", () => {
  assert.equal(bySku(rowsOf(product({ sku: "mkplain", price: 42.5 })), "mkplain").price, 42.5);
});

test("a product with no usable price is still not given one", () => {
  const r = bySku(rowsOf(product({ sku: "mkzero", price: 0 })), "mkzero");
  assert.equal(r.price, null, "zero/absent price is never invented");
});

test("the policy suppresses the discount at the boundary, deterministically", () => {
  assert.equal(RAFEEQ_SNOONU_ALIGNED_PRICING, true);
  assert.equal(rafeeqExportDiscountPrice(235.5), null);
  assert.equal(rafeeqExportDiscountPrice(null), null);
});

// ── 5. the APP path really goes through the seam ─────────────────────────────

test("the Rafeeq server reader feeds the engine through the policy seam", () => {
  const src = strip(readFileSync(new URL("./preview.server.ts", import.meta.url), "utf8"));
  assert.ok(/discountPrice:\s*rafeeqExportDiscountPrice\(n\(p\.discount_price\)\)/.test(src),
    "preview.server.ts must project discount_price through the policy");
  assert.equal(/discountPrice:\s*n\(p\.discount_price\)\s*,/.test(src), false,
    "the raw discount must not reach the engine");
});

test("the policy changes ONLY the Rafeeq exporter", () => {
  for (const rel of ["../snoonu/preview.server.ts", "../talabat/preview.server.ts"]) {
    const src = strip(readFileSync(new URL(rel, import.meta.url), "utf8"));
    assert.equal(/rafeeqExportDiscountPrice|RAFEEQ_SNOONU_ALIGNED_PRICING/.test(src), false,
      `${rel} must be untouched by the Rafeeq pricing policy`);
  }
});

test("no canonical price is written or mutated by the exporter", () => {
  for (const rel of ["./preview.ts", "./preview.server.ts"]) {
    const src = strip(readFileSync(new URL(rel, import.meta.url), "utf8"));
    for (const re of [/\.update\s*\(/, /\.insert\s*\(/, /\.upsert\s*\(/, /\.delete\s*\(/, /\.rpc\s*\(/]) {
      assert.equal(re.test(src), false, `${rel} must not write`);
    }
  }
});
