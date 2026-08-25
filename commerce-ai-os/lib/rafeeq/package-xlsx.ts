// RAFEEQ workbook SERIALIZER (SheetJS) — two sheets (owner clarity requirement):
//   • "data"              — the AUDITED native Rafeeq import sheet (exactly the
//     40 audited headers, FIRST sheet, machine-import authoritative);
//   • "Malikas Reference" — the human-readable explanatory sheet for Rafeeq
//     staff (reference-only; carries the REAL barcode, never the data sheet).
// Spreadsheet correctness enforced — identity/text cells stored as TEXT (no
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
import { MALIKAS_REFERENCE_SHEET, REFERENCE_COL } from "../export/rafeeq/reference.ts";
import type { AoaCell } from "../export/package-core.ts";

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

/** Reference-sheet columns stored as TEXT (everything except OPTION PRICE). */
const REFERENCE_TEXT_COLUMNS = new Set<number>(
  Object.values(REFERENCE_COL).filter((c) => c !== REFERENCE_COL.optionPrice),
);
const REFERENCE_COL_WIDTHS = [12, 16, 34, 34, 20, 20, 14, 14, 8, 14, 14, 22, 22, 10, 14, 28];

/**
 * Serialize the Rafeeq workbook. The "data" sheet is ALWAYS first (the
 * machine-import contract); the "Malikas Reference" sheet is appended when its
 * AoA is provided (the production package always provides it — tests may not).
 */
export function buildRafeeqXlsxBuffer(rows: readonly RafeeqPackageRow[], referenceAoa?: readonly (readonly AoaCell[])[]): Uint8Array {
  const require = createRequire(import.meta.url);
  const XLSX = require("xlsx");

  const typeCells = (ws: Record<string, { t: string; v: unknown; z?: string }> & { ["!ref"]?: string }, textCols: Set<number>) => {
    const range = XLSX.utils.decode_range(ws["!ref"]);
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
  };

  const aoa = buildRafeeqXlsxAoa(rows);
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  typeCells(ws, new Set<number>(RAFEEQ_NATIVE_TEXT_COLUMNS));
  ws["!cols"] = RAFEEQ_NATIVE_COL_WIDTHS.map((wch) => ({ wch }));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, RAFEEQ_NATIVE_SHEET);

  if (referenceAoa) {
    const ref = XLSX.utils.aoa_to_sheet(referenceAoa as AoaCell[][]);
    typeCells(ref, REFERENCE_TEXT_COLUMNS);
    ref["!cols"] = REFERENCE_COL_WIDTHS.map((wch) => ({ wch }));
    XLSX.utils.book_append_sheet(wb, ref, MALIKAS_REFERENCE_SHEET);
  }

  const buf: Buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  return new Uint8Array(buf);
}
