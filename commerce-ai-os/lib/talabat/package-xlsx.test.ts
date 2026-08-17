// INT.2B.2 — Talabat XLSX serializer round-trip tests (real SheetJS).
// Proves spreadsheet correctness (§13): barcode/SKU as TEXT (no scientific
// notation, no leading-zero loss), numeric price, UTF-8/Arabic content, and the
// formula-injection guard surviving into the written cell.
// node --conditions=react-server --experimental-strip-types --test lib/talabat/package-xlsx.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { buildTalabatXlsxBuffer } from "./package-xlsx.ts";
import { TALABAT_HEADERS } from "./export.ts";
import type { TalabatPackageRow } from "../export/talabat/package.ts";

const require = createRequire(import.meta.url);
const XLSX = require("xlsx");

function pkgRow(over: Partial<TalabatPackageRow> = {}): TalabatPackageRow {
  return {
    sku: "mk1234",
    barcode: "6291041500213",
    priceQar: 65,
    discount: "",
    nameEn: "Vitamin C Serum",
    nameAr: "سيروم فيتامين سي",
    category: "Korean Skincare",
    descriptionEn: "Bright skin.",
    descriptionAr: "بشرة مشرقة.",
    imageFilename: "mk1234.jpg",
    ...over,
  };
}

function readBack(rows: TalabatPackageRow[]) {
  const buf = buildTalabatXlsxBuffer(rows);
  const wb = XLSX.read(buf, { type: "buffer" });
  return wb.Sheets[wb.SheetNames[0]];
}

test("header row equals the certified Talabat template", () => {
  const ws = readBack([pkgRow()]);
  const header = XLSX.utils.sheet_to_json(ws, { header: 1 })[0];
  assert.deepEqual(header, [...TALABAT_HEADERS]);
});

test("barcode is stored as TEXT — no scientific notation", () => {
  const ws = readBack([pkgRow({ barcode: "6291041500213" })]);
  assert.equal(ws["B2"].t, "s", "barcode cell is a string");
  assert.equal(ws["B2"].v, "6291041500213");
});

test("SKU leading zeros are preserved (stored as text)", () => {
  const ws = readBack([pkgRow({ sku: "007123" })]);
  assert.equal(ws["A2"].t, "s");
  assert.equal(ws["A2"].v, "007123");
});

test("price is a real number cell", () => {
  const ws = readBack([pkgRow({ priceQar: 65 })]);
  assert.equal(ws["C2"].t, "n");
  assert.equal(ws["C2"].v, 65);
});

test("a null price becomes a blank cell (never a false 0)", () => {
  const ws = readBack([pkgRow({ priceQar: null })]);
  // an empty string cell (or absent) — never a numeric 0
  assert.ok(!ws["C2"] || ws["C2"].v === "" , "blank price is not a number");
});

test("Arabic and English content survive the round-trip", () => {
  const ws = readBack([pkgRow({ nameEn: "Rose Serum", nameAr: "سيروم الورد" })]);
  assert.equal(ws["E2"].v, "Rose Serum");
  assert.equal(ws["F2"].v, "سيروم الورد");
});

test("formula-injection text is neutralized in the written cell", () => {
  const ws = readBack([pkgRow({ nameEn: "=HYPERLINK(\"http://x\")", category: "@SUM(1)" })]);
  assert.equal(ws["E2"].t, "s");
  assert.equal(ws["E2"].v, "'=HYPERLINK(\"http://x\")");
  assert.equal(ws["G2"].v, "'@SUM(1)");
});

test("image filename cell exactly matches the packaged file (text)", () => {
  const ws = readBack([pkgRow({ imageFilename: "lt-red.webp" })]);
  assert.equal(ws["J2"].t, "s");
  assert.equal(ws["J2"].v, "lt-red.webp");
});

test("row order is deterministic (input order preserved)", () => {
  const ws = readBack([pkgRow({ sku: "a1" }), pkgRow({ sku: "b2" }), pkgRow({ sku: "c3" })]);
  assert.equal(ws["A2"].v, "a1");
  assert.equal(ws["A3"].v, "b2");
  assert.equal(ws["A4"].v, "c3");
});
