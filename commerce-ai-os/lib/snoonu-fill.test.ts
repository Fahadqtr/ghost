import test from "node:test";
import assert from "node:assert/strict";

import { normName, buildCodeIndex, matchCode, fillCodes } from "./snoonu-fill.ts";

const catalog = [
  { snoonu_id: "spi-1", sku: "mk1001", barcode: "2900000000015", name_en: "Pink Scalp Massage Brush", name_ar: "فرشاة تدليك وردية" },
  { snoonu_id: "spi-2", sku: "mk1002", barcode: "", name_en: "Soft Hair Wax Sticks", name_ar: "عصي شمع شعر ناعم" },
  { snoonu_id: "spi-3", sku: "", barcode: "", name_en: "No Code Product", name_ar: "بدون كود" }, // not indexed
];

test("normName folds dashes/quotes/case and collapses spaces", () => {
  assert.equal(normName("  Y2K  Blue – Cat’s  Eye  "), "y2k blue - cat's eye");
});

test("buildCodeIndex indexes only rows that carry a code", () => {
  const idx = buildCodeIndex(catalog);
  assert.equal(idx.bySpi.has("spi-1"), true);
  assert.equal(idx.bySpi.has("spi-2"), true);
  assert.equal(idx.bySpi.has("spi-3"), false); // no sku/barcode → skipped
});

test("matchCode prefers SPI, returns the real codes", () => {
  const idx = buildCodeIndex(catalog);
  const r = matchCode({ spi: "spi-1", nameEn: "totally different" }, idx);
  assert.deepEqual(r, { sku: "mk1001", barcode: "2900000000015", matched: "spi" });
});

test("matchCode falls back to name (En then Ar) when SPI misses", () => {
  const idx = buildCodeIndex(catalog);
  const byEn = matchCode({ spi: "", nameEn: "soft hair WAX sticks" }, idx);
  assert.equal(byEn.matched, "name");
  assert.equal(byEn.sku, "mk1002");
  const byAr = matchCode({ spi: "unknown", nameAr: "فرشاة تدليك وردية" }, idx);
  assert.equal(byAr.matched, "name");
  assert.equal(byAr.barcode, "2900000000015");
});

test("matchCode returns empty when nothing matches", () => {
  const idx = buildCodeIndex(catalog);
  assert.deepEqual(matchCode({ spi: "zzz", nameEn: "ghost" }, idx), { sku: "", barcode: "", matched: null });
});

test("fillCodes preserves input order", () => {
  const idx = buildCodeIndex(catalog);
  const out = fillCodes([{ spi: "spi-2" }, { spi: "nope" }, { spi: "spi-1" }], idx);
  assert.deepEqual(out.map((r) => r.sku), ["mk1002", "", "mk1001"]);
});
