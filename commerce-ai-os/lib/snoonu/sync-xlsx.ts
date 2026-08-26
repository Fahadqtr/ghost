// SNOONU CATALOG SYNC — return/update workbook SERIALIZER (SheetJS).
//
// Preserves the Snoonu update-workbook schema exactly (headers verbatim from
// the pure builder) with spreadsheet correctness: SPI / SKU / Barcode stored
// as TEXT (no scientific notation, no leading-zero loss), price numeric,
// UTF-8/Arabic preserved. Values come from the pure builder only — a PENDING
// sentinel SKU is already blanked there, nothing is invented here.

import { createRequire } from "node:module";
import { buildSnoonuReturnAoa, type SnoonuReturnRecord } from "./sync.ts";

const TEXT_COLS = new Set([0, 5, 6]); // SPI, SKU(Update), Barcode(Update)
const PRICE_COL = 7;

export function buildSnoonuReturnXlsxBuffer(records: readonly SnoonuReturnRecord[]): Uint8Array {
  const require = createRequire(import.meta.url);
  const XLSX = require("xlsx");
  const aoa = buildSnoonuReturnAoa(records);
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const range = XLSX.utils.decode_range(ws["!ref"]);
  for (let r = range.s.r + 1; r <= range.e.r; r++) {
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      if (!cell) continue;
      if (TEXT_COLS.has(c)) {
        cell.t = "s";
        cell.v = String(cell.v ?? "");
        cell.z = "@";
      } else if (c === PRICE_COL && typeof cell.v === "number") {
        cell.t = "n";
      }
    }
  }
  ws["!cols"] = [26, 34, 34, 40, 40, 18, 18, 14, 30].map((wch) => ({ wch }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Products");
  return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
}
