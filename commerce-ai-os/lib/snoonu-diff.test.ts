// Tests for the pure Snoonu catalog diff logic.
// Run: node --conditions=react-server --experimental-strip-types --test lib/snoonu-diff.test.ts
//
// This is what decides which catalog rows an import UPDATES/creates/flags, and
// the normalized value it writes. A bug here silently corrupts the catalog or
// floods the diff with cosmetic false-positives, so pin the behavior down.

import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeText, writeVal, computeChanges, diffSnoonu,
  mapExportRows, normHeader, readColumns, ALWAYS, OPTIONAL,
  type Field, type SnoonuExportRow,
} from "./snoonu-diff.ts";

const FIELDS: Field[] = [...ALWAYS, ...OPTIONAL];

// ---- normalizeText: cosmetic noise must vanish, real words must survive -----
test("normalizeText strips emojis and decorative symbols", () => {
  assert.equal(normalizeText("Glow Cream 🌸✨"), "Glow Cream");
  assert.equal(normalizeText("◆ Serum ◆"), "Serum");
});

test("normalizeText decodes HTML entities and literal escapes", () => {
  assert.equal(normalizeText("Rose &amp; Gold"), "Rose & Gold");
  assert.equal(normalizeText("it&#39;s"), "it's");
  assert.equal(normalizeText("line1\\nline2"), "line1\nline2");
});

test("normalizeText collapses whitespace, NBSP, and zero-width chars", () => {
  assert.equal(normalizeText("a ​  b"), "a b");
  assert.equal(normalizeText("  trim me  "), "trim me");
  assert.equal(normalizeText("a\r\n\r\nb"), "a\nb");
});

// ---- writeVal: type coercion for the value actually written on Apply --------
test("writeVal coerces num / bool / str", () => {
  assert.equal(writeVal("num", "12.5"), 12.5);
  assert.equal(writeVal("num", "abc"), null);
  assert.equal(writeVal("bool", "yes"), true);
  assert.equal(writeVal("bool", "0"), false);
  assert.equal(writeVal("bool", "maybe"), null);
  assert.equal(writeVal("str", "Hello"), "Hello");
});

// ---- computeChanges: the per-product change detector -----------------------
test("computeChanges ignores cosmetic-only text differences", () => {
  const p = { name_en: "Glow Cream" };
  const r: SnoonuExportRow = { id: "1", name_en: "Glow Cream ✨" };
  assert.deepEqual(computeChanges(p, r, ALWAYS), []);
});

test("computeChanges reports a real text change with the normalized new value", () => {
  const p = { name_en: "Glow Cream" };
  const r: SnoonuExportRow = { id: "1", name_en: "Glow Serum 🌸" };
  const ch = computeChanges(p, r, ALWAYS);
  assert.equal(ch.length, 1);
  assert.equal(ch[0].field, "name_en");
  assert.equal(ch[0].new, "Glow Serum"); // emoji normalized out of the written value
  assert.equal(ch[0].writeValue, "Glow Serum");
});

test("computeChanges skips empty export cells (a blank never blanks our data)", () => {
  const p = { name_en: "Keep me", price: 10 };
  const r: SnoonuExportRow = { id: "1", name_en: "", price: "" };
  assert.deepEqual(computeChanges(p, r, ALWAYS), []);
});

test("computeChanges treats numeric 10 vs '10' as equal, 10 vs '12' as changed", () => {
  assert.deepEqual(computeChanges({ price: 10 }, { id: "1", price: "10" }, ALWAYS), []);
  const ch = computeChanges({ price: 10 }, { id: "1", price: "12" }, ALWAYS);
  assert.equal(ch.length, 1);
  assert.equal(ch[0].field, "price");
  assert.equal(ch[0].writeValue, 12);
});

test("computeChanges normalizes booleans (db true vs export 'yes' is unchanged)", () => {
  assert.deepEqual(computeChanges({ is_featured: true }, { id: "1", is_featured: "yes" }, OPTIONAL), []);
  const ch = computeChanges({ is_featured: false }, { id: "1", is_featured: "true" }, OPTIONAL);
  assert.equal(ch.length, 1);
  assert.equal(ch[0].writeValue, true);
});

// ---- diffSnoonu: matched / updated / new / missing / unchanged -------------
test("diffSnoonu classifies updated, new, missing, and unchanged rows", () => {
  const products = [
    { id: "p1", snoonu_id: "1", sku: "mk1", name_en: "Cream", price: 10 },  // will be updated
    { id: "p2", snoonu_id: "2", sku: "mk2", name_en: "Serum", price: 20 },  // unchanged
    { id: "p3", snoonu_id: "3", sku: "mk3", name_en: "Toner", price: 30 },  // missing from export
  ];
  const rows: SnoonuExportRow[] = [
    { id: "1", name_en: "Cream", price: "15" },  // price changed 10 -> 15
    { id: "2", name_en: "Serum", price: "20" },  // same
    { id: "9", name_en: "Brand New" },           // no matching product -> new
  ];
  const d = diffSnoonu(products, rows, ALWAYS);

  assert.equal(d.matched, 2);              // ids 1 and 2 exist in catalog
  assert.equal(d.unchanged, 1);            // id 2
  assert.equal(d.updated.length, 1);
  assert.equal(d.updated[0].product_id, "p1");
  assert.equal(d.updated[0].changes[0].field, "price");
  assert.equal(d.newProducts.length, 1);
  assert.equal(d.newProducts[0].id, "9");
  assert.equal(d.missing.length, 1);
  assert.equal(d.missing[0].product_id, "p3");
});

test("diffSnoonu skips rows without an id", () => {
  const d = diffSnoonu([], [{ id: "", name_en: "no id" }], ALWAYS);
  assert.equal(d.newProducts.length, 0);
  assert.equal(d.matched, 0);
});

// ---- header mapping: must accept the REAL Snoonu export headers -------------
test("normHeader strips punctuation and case", () => {
  assert.equal(normHeader("SPI(UniqueIdentifier)"), "spiuniqueidentifier");
  assert.equal(normHeader("Price Global(Update)"), "priceglobalupdate");
});

test("mapExportRows maps real Snoonu headers and prefix-matches availability/stock", () => {
  const raw = [{
    "SPI(UniqueIdentifier)": "42",
    "Product Name (En)(ReadOnly)": "Glow Cream",
    "Price Global(Update)": "19.99",
    "Availability MalikasUniverse": "False",
    "Stock MalikasUniverse": "0",
  }];
  const { rows, hasId } = mapExportRows(raw);
  assert.equal(hasId, true);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "42");
  assert.equal(rows[0].name_en, "Glow Cream");
  assert.equal(rows[0].price, "19.99");
  assert.equal(rows[0].availability, "False");
  assert.equal(rows[0].stock, "0");
});

test("mapExportRows drops rows without an id and handles an empty sheet", () => {
  assert.deepEqual(mapExportRows([]), { rows: [], hasId: false, headers: [] });
  const { rows } = mapExportRows([{ id: "1" }, { id: "" }]);
  assert.equal(rows.length, 1);
});

// ---- readColumns: identity columns + field columns, deduped ----------------
test("readColumns includes identity columns and dedupes", () => {
  const cols = readColumns([{ ex: "name_en", col: "name_en", type: "str" }]);
  const set = new Set(cols.split(",").map((c) => c.trim()));
  for (const must of ["id", "snoonu_id", "sku", "name_en"]) assert.ok(set.has(must), `has ${must}`);
  assert.equal(cols.split(",").filter((c) => c.trim() === "name_en").length, 1); // not duplicated
});
