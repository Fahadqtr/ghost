// INT.2D — Rafeeq XLSX serializer round-trip tests (real SheetJS).
// node --conditions=react-server --experimental-strip-types --test lib/rafeeq/package-xlsx.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { buildRafeeqXlsxBuffer } from "./package-xlsx.ts";
import { RAFEEQ_HEADERS } from "../exporters.ts";
import type { RafeeqPackageRow } from "../export/rafeeq/package.ts";

const require = createRequire(import.meta.url);
const XLSX = require("xlsx");

function pkgRow(over: Partial<RafeeqPackageRow> = {}): RafeeqPackageRow {
  return {
    categoryEn: "Makeup", categoryAr: "المكياج", nameEn: "Serum", nameAr: "سيروم", price: 65,
    descriptionEn: "Bright.", descriptionAr: "مشرق.", imageName: "MK1.jpg", barcode: "6291041500213", rafeeqId: "RFQ-1",
    ...over,
  };
}
function readBack(rows: RafeeqPackageRow[]) {
  const wb = XLSX.read(buildRafeeqXlsxBuffer(rows), { type: "buffer" });
  return wb.Sheets[wb.SheetNames[0]];
}

test("header equals the canonical Rafeeq template", () => {
  assert.deepEqual(XLSX.utils.sheet_to_json(readBack([pkgRow()]), { header: 1 })[0], [...RAFEEQ_HEADERS]);
});

test("IMAGE NAME, BARCODE, RAFEEQ ID are TEXT — leading zeros + no scientific notation", () => {
  const ws = readBack([pkgRow({ imageName: "007SKU.jpg", barcode: "6291041500213", rafeeqId: "0099" })]);
  assert.equal(ws["H2"].t, "s"); assert.equal(ws["H2"].v, "007SKU.jpg");
  assert.equal(ws["I2"].t, "s"); assert.equal(ws["I2"].v, "6291041500213");
  assert.equal(ws["J2"].t, "s"); assert.equal(ws["J2"].v, "0099");
});

test("price numeric; Arabic + formula injection handled", () => {
  const ws = readBack([pkgRow({ price: 65, nameAr: "سيروم الورد", nameEn: "=danger()" })]);
  assert.equal(ws["E2"].t, "n"); assert.equal(ws["E2"].v, 65);
  assert.equal(ws["D2"].v, "سيروم الورد");
  assert.equal(ws["C2"].v, "'=danger()");
});

test("new product keeps the literal marker in RAFEEQ ID", () => {
  const ws = readBack([pkgRow({ rafeeqId: "new product" })]);
  assert.equal(ws["J2"].v, "new product");
});
