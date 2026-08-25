// Rafeeq NATIVE XLSX serializer round-trip tests (real SheetJS).
// node --conditions=react-server --experimental-strip-types --test lib/rafeeq/package-xlsx.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { buildRafeeqXlsxBuffer } from "./package-xlsx.ts";
import { RAFEEQ_NATIVE_HEADERS, RAFEEQ_NATIVE_SHEET, NATIVE_COL } from "../export/rafeeq/native-template.ts";
import type { RafeeqPackageRow } from "../export/rafeeq/package.ts";

const require = createRequire(import.meta.url);
const XLSX = require("xlsx");

function pkgRow(over: Partial<RafeeqPackageRow> = {}): RafeeqPackageRow {
  return {
    categoryKey: "Makeup", nameEn: "Serum", nameAr: "سيروم", price: 65, priceOnSelection: false,
    descriptionEn: "Bright.", descriptionAr: "مشرق.", imageName: "MK1.jpg", barcode: "MK1", rafeeqId: "691300001",
    groupNameEn: "Options", groupNameAr: "الخيارات", options: [],
    ...over,
  };
}
function readBack(rows: RafeeqPackageRow[]) {
  const wb = XLSX.read(buildRafeeqXlsxBuffer(rows), { type: "buffer" });
  return { ws: wb.Sheets[wb.SheetNames[0]], sheetName: wb.SheetNames[0] as string };
}
const cell = (ws: Record<string, { t: string; v: unknown }>, col: number, row: number) =>
  ws[XLSX.utils.encode_cell({ r: row, c: col })];

test("worksheet is named 'data' and the header equals the audited 40-column template", () => {
  const { ws, sheetName } = readBack([pkgRow()]);
  assert.equal(sheetName, RAFEEQ_NATIVE_SHEET);
  assert.deepEqual(XLSX.utils.sheet_to_json(ws, { header: 1 })[0], [...RAFEEQ_NATIVE_HEADERS]);
});

test("product_id / barcode / product_price are TEXT — leading zeros + no scientific notation; price text per audit", () => {
  const { ws } = readBack([pkgRow({ rafeeqId: "0099", barcode: "mk007", price: 69.5 })]);
  const id = cell(ws, NATIVE_COL.productId, 1);
  assert.equal(id.t, "s"); assert.equal(id.v, "0099");
  const bc = cell(ws, NATIVE_COL.barcode, 1);
  assert.equal(bc.t, "s"); assert.equal(bc.v, "mk007");
  const price = cell(ws, NATIVE_COL.productPrice, 1);
  assert.equal(price.t, "s"); assert.equal(price.v, "69.5");
});

test("Arabic preserved; formula injection neutralized; numeric flags stay numeric", () => {
  const { ws } = readBack([pkgRow({ nameAr: "سيروم الورد", nameEn: "=danger()" })]);
  assert.equal(cell(ws, NATIVE_COL.productNameAr, 1).v, "سيروم الورد");
  assert.equal(cell(ws, NATIVE_COL.productNameEn, 1).v, "'=danger()");
  assert.equal(cell(ws, NATIVE_COL.productStatus, 1).t, "n");
  assert.equal(cell(ws, NATIVE_COL.groups, 1).v, 0);
});

test("PRICE ON SELECTION serializes as TEXT with FULL numeric option prices", () => {
  const { ws } = readBack([pkgRow({
    price: null,
    priceOnSelection: true,
    options: [
      { nameEn: "Silver", nameAr: "فضي", price: 158, sortOrder: 1 },
      { nameEn: "Gold", nameAr: "ذهبي", price: 178, sortOrder: 2 },
    ],
  })]);
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" }) as unknown[][];
  assert.equal(aoa[1][NATIVE_COL.productPrice], "PRICE ON SELECTION");
  assert.equal(aoa[2][NATIVE_COL.productPrice], "PRICE ON SELECTION");
  assert.equal(cell(ws, NATIVE_COL.optionPrice, 1).t, "n");
  assert.deepEqual([aoa[1][NATIVE_COL.optionPrice], aoa[2][NATIVE_COL.optionPrice]], [158, 178]);
});

test("a new record keeps a BLANK product_id and an option product expands to repeated rows", () => {
  const { ws } = readBack([pkgRow({
    rafeeqId: "",
    options: [
      { nameEn: "Red", nameAr: "أحمر", price: 0, sortOrder: 1 },
      { nameEn: "Blue", nameAr: "أزرق", price: 0, sortOrder: 2 },
    ],
  })]);
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" }) as unknown[][];
  assert.equal(aoa.length, 3, "header + one row per option");
  for (const r of [1, 2]) {
    assert.equal(aoa[r][NATIVE_COL.productId], "", "blank product_id for a new record");
    assert.equal(aoa[r][NATIVE_COL.barcode], "MK1", "parent SKU repeated");
    assert.equal(aoa[r][NATIVE_COL.groups], 1);
  }
  assert.equal(aoa[1][NATIVE_COL.optionNameEn], "Red");
  assert.equal(aoa[2][NATIVE_COL.optionNameEn], "Blue");
  assert.equal(cell(ws, NATIVE_COL.optionPrice, 1).t, "n");
  assert.equal(cell(ws, NATIVE_COL.optionPrice, 1).v, 0);
});
