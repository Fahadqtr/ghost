// INT.2C — Snoonu XLSX serializer round-trip tests (real SheetJS).
// node --conditions=react-server --experimental-strip-types --test lib/snoonu/package-xlsx.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { buildSnoonuXlsxBuffer } from "./package-xlsx.ts";
import { SNOONU_HEADERS } from "../exporters.ts";
import type { SnoonuPackageRow } from "../export/snoonu/package.ts";

const require = createRequire(import.meta.url);
const XLSX = require("xlsx");

function pkgRow(over: Partial<SnoonuPackageRow> = {}): SnoonuPackageRow {
  return {
    snoonuId: "SPI-1001", sku: "MK1", barcode: "6291041500213", nameEn: "Serum", nameAr: "سيروم",
    category: "Skincare", subCategory: "Face", price: 65, discountPrice: null, stock: "",
    snoonuStatus: "Listed", imageUrl: "https://cdn.example.com/mk1.jpg",
    descriptionEn: "Bright.", descriptionAr: "مشرق.", keywordsEn: "serum", keywordsAr: "سيروم",
    imageFilename: "MK1.jpg", ...over,
  };
}
function readBack(rows: SnoonuPackageRow[]) {
  const wb = XLSX.read(buildSnoonuXlsxBuffer(rows), { type: "buffer" });
  return wb.Sheets[wb.SheetNames[0]];
}

test("header equals the canonical Snoonu template", () => {
  const ws = readBack([pkgRow()]);
  assert.deepEqual(XLSX.utils.sheet_to_json(ws, { header: 1 })[0], [...SNOONU_HEADERS]);
});

test("Snoonu ID (SPI), SKU and barcode are TEXT — no scientific notation", () => {
  const ws = readBack([pkgRow({ snoonuId: "1234567890123", sku: "007123", barcode: "6291041500213" })]);
  assert.equal(ws["A2"].t, "s"); assert.equal(ws["A2"].v, "1234567890123");
  assert.equal(ws["B2"].t, "s"); assert.equal(ws["B2"].v, "007123"); // leading zeros preserved
  assert.equal(ws["C2"].t, "s"); assert.equal(ws["C2"].v, "6291041500213");
});

test("price is numeric; blank SPI stays blank for a new product", () => {
  const ws = readBack([pkgRow({ price: 65, snoonuId: "" })]);
  assert.equal(ws["H2"].t, "n"); assert.equal(ws["H2"].v, 65);
  assert.ok(!ws["A2"] || ws["A2"].v === "", "new product → blank Snoonu ID");
});

test("Arabic + English survive; formula injection neutralized", () => {
  const ws = readBack([pkgRow({ nameAr: "سيروم الورد", nameEn: "=cmd()" })]);
  assert.equal(ws["E2"].v, "سيروم الورد");
  assert.equal(ws["D2"].v, "'=cmd()");
});
