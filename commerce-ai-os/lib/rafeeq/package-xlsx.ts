// RAFEEQ NATIVE sheet SERIALIZER (SheetJS).
//
// Turns the pure native package rows into workbook bytes on the AUDITED real
// Rafeeq template: ONE worksheet named "data", exactly the 40 audited headers,
// spreadsheet correctness enforced — identity/text cells stored as TEXT (no
// scientific notation, no leading-zero loss; product_price is TEXT per the
// audited workbook), numeric flag/sort cells numeric, UTF-8/Arabic preserved,
// deterministic column + row order (the pure AoA order). Kept OUT of the
// server-only module so it is directly unit-testable.

import { createRequire } from "node:module";
import {
  RAFEEQ_NATIVE_SHEET,
  RAFEEQ_NATIVE_COL_WIDTHS,
  NATIVE_COL,
} from "../export/rafeeq/native-template.ts";
import { buildRafeeqXlsxAoa, type RafeeqPackageRow } from "../export/rafeeq/package.ts";

/** Columns stored as spreadsheet TEXT (identity + free text + audited-text price). */
export const RAFEEQ_NATIVE_TEXT_COLUMNS: readonly number[] = [
  NATIVE_COL.categoryNameEn,
  NATIVE_COL.categoryNameAr,
  NATIVE_COL.subcategoryNameEn,
  NATIVE_COL.subcategoryNameAr,
  NATIVE_COL.productId,
  NATIVE_COL.productNameEn,
  NATIVE_COL.productNameAr,
  NATIVE_COL.productDescriptionEn,
  NATIVE_COL.productDescriptionAr,
  NATIVE_COL.productPrice, // audited workbook stores product_price as text
  NATIVE_COL.barcode,
  NATIVE_COL.posId,
  NATIVE_COL.productImage,
  NATIVE_COL.groupId,
  NATIVE_COL.groupNameEn,
  NATIVE_COL.groupNameAr,
  NATIVE_COL.optionId,
  NATIVE_COL.optionNameEn,
  NATIVE_COL.optionNameAr,
];

export function buildRafeeqXlsxBuffer(rows: readonly RafeeqPackageRow[]): Uint8Array {
  const require = createRequire(import.meta.url);
  const XLSX = require("xlsx");

  const aoa = buildRafeeqXlsxAoa(rows);
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const range = XLSX.utils.decode_range(ws["!ref"]);
  const textCols = new Set<number>(RAFEEQ_NATIVE_TEXT_COLUMNS);

  for (let r = range.s.r; r <= range.e.r; r++) {
    if (r === range.s.r) continue; // header row: default strings
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      if (!cell) continue;
      if (textCols.has(c)) {
        cell.t = "s";
        cell.v = String(cell.v ?? "");
        cell.z = "@";
      } else if (typeof cell.v === "number") {
        cell.t = "n";
      }
    }
  }

  ws["!cols"] = RAFEEQ_NATIVE_COL_WIDTHS.map((wch) => ({ wch }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, RAFEEQ_NATIVE_SHEET);
  const buf: Buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  return new Uint8Array(buf);
}
