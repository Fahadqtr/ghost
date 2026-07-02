// Tests for the pure per-channel CSV/AoA export builders.
// Run: node --conditions=react-server --experimental-strip-types --test lib/exporters.test.ts
//
// These produce the files uploaded to each sales channel. A CSV-escaping bug (a
// comma/quote/newline in a product name) silently corrupts a whole export, and a
// wrong status/category mapping mis-lists products — so pin the escaping and the
// per-channel field mapping.

import test from "node:test";
import assert from "node:assert/strict";

import {
  toCsv, buildShopifyCsv, buildSnoonuCsv, buildRafeeqAoa, buildRafeeqCsv,
  SHOPIFY_HEADERS, SNOONU_HEADERS, RAFEEQ_HEADERS,
  type ExportProduct, type StatusMap,
} from "./exporters.ts";

function product(overrides: Partial<ExportProduct> = {}): ExportProduct {
  return {
    id: "p1", sku: "mk1", snoonu_id: null, rafeeq_product_id: null, barcode: "123",
    name_en: "Glow Cream", name_ar: "كريم", main_category: "Masks", sub_category: null,
    product_type: null, price: 10, discount_price: null, image_url: null, image_filename: null,
    description_en: "Nice", description_ar: "جميل", keywords_en: null, keywords_ar: null,
    ...overrides,
  };
}

// ---- CSV escaping (the highest-risk part) ----------------------------------
test("toCsv quotes fields containing comma, quote, or newline; doubles inner quotes", () => {
  const csv = toCsv(["a", "b", "c", "d"], [["plain", "has,comma", 'has"quote', "has\nnewline"]]);
  const dataRow = csv.split("\r\n")[1];
  assert.equal(dataRow, 'plain,"has,comma","has""quote","has\nnewline"');
});

test("toCsv renders null/undefined as empty cells and uses CRLF row separators", () => {
  const csv = toCsv(["a", "b"], [[null, undefined]]);
  assert.equal(csv, "a,b\r\n,");
});

// ---- Shopify ---------------------------------------------------------------
test("buildShopifyCsv derives a handle and maps Active status to Published TRUE", () => {
  const status: StatusMap = { p1: "Active" };
  const csv = buildShopifyCsv([product({ name_en: "Glow Cream!" })], status);
  const [header, row] = csv.split("\r\n");
  assert.equal(header, SHOPIFY_HEADERS.join(","));
  const cells = row.split(",");
  assert.equal(cells[0], "glow-cream");                 // Handle (slugified, trailing punct dropped)
  assert.equal(cells[SHOPIFY_HEADERS.indexOf("Published")], "TRUE");
});

test("buildShopifyCsv publishes FALSE when the channel status is not Active", () => {
  const csv = buildShopifyCsv([product()], { p1: "Paused" });
  const cells = csv.split("\r\n")[1].split(",");
  assert.equal(cells[SHOPIFY_HEADERS.indexOf("Published")], "FALSE");
});

// ---- Snoonu ----------------------------------------------------------------
test("buildSnoonuCsv defaults an unmapped status to 'Not Listed'", () => {
  const csv = buildSnoonuCsv([product({ snoonu_id: "S9" })], {});
  const cells = csv.split("\r\n")[1].split(",");
  assert.equal(cells[SNOONU_HEADERS.indexOf("Snoonu Status")], "Not Listed");
});

// ---- Rafeeq ----------------------------------------------------------------
test("buildRafeeqAoa fills the Arabic category and defaults a missing Rafeeq ID", () => {
  const aoa = buildRafeeqAoa([product({ main_category: "Masks", rafeeq_product_id: null })]);
  assert.deepEqual(aoa[0], RAFEEQ_HEADERS);            // header row first
  const row = aoa[1];
  assert.equal(row[0], "Masks");
  assert.equal(row[1], "الأقنعة");                      // AR looked up from RAFEEQ_CATEGORIES
  assert.equal(row[RAFEEQ_HEADERS.indexOf("RAFEEQ ID")], "new product");
});

test("buildRafeeqAoa leaves Arabic category blank for an unknown category", () => {
  const row = buildRafeeqAoa([product({ main_category: "Nonexistent" })])[1];
  assert.equal(row[1], "");
});

test("buildRafeeqCsv emits the header exactly once", () => {
  const csv = buildRafeeqCsv([product()], {});
  const lines = csv.split("\r\n");
  assert.equal(lines[0], RAFEEQ_HEADERS.join(","));
  assert.equal(lines.filter((l) => l === RAFEEQ_HEADERS.join(",")).length, 1);
});
