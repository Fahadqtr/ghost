// INT.2D — Rafeeq sheet SERIALIZER (SheetJS).
//
// Turns the pure Rafeeq package rows into the rafeeq-products.xlsx bytes,
// enforcing spreadsheet correctness: IMAGE NAME / BARCODE / RAFEEQ ID stored as
// TEXT (no scientific notation, no leading-zero loss), price numeric, UTF-8/
// Arabic preserved, deterministic column + row order (the pure AoA order). Reuses
// the existing Rafeeq column widths. Kept OUT of the server-only module so it is
// directly unit-testable; the INT.2A read-only guard scans lib/export, not
// lib/rafeeq, so SheetJS lives here.

import { createRequire } from "node:module";
import { RAFEEQ_COL_WIDTHS } from "../exporters.ts";
import {
  buildRafeeqXlsxAoa,
  RAFEEQ_TEXT_COLUMNS,
  RAFEEQ_PRICE_COLUMN,
  type RafeeqPackageRow,
} from "../export/rafeeq/package.ts";

export function buildRafeeqXlsxBuffer(rows: readonly RafeeqPackageRow[]): Uint8Array {
  const require = createRequire(import.meta.url);
  const XLSX = require("xlsx");

  const aoa = buildRafeeqXlsxAoa(rows);
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const range = XLSX.utils.decode_range(ws["!ref"]);
  const textCols = new Set<number>(RAFEEQ_TEXT_COLUMNS as readonly number[]);

  for (let r = range.s.r; r <= range.e.r; r++) {
    if (r === range.s.r) continue; // header row: default strings
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      if (!cell) continue;
      if (textCols.has(c)) {
        cell.t = "s";
        cell.v = String(cell.v ?? "");
        cell.z = "@";
      } else if (c === RAFEEQ_PRICE_COLUMN && typeof cell.v === "number") {
        cell.t = "n";
      }
    }
  }

  ws["!cols"] = RAFEEQ_COL_WIDTHS.map((wch) => ({ wch }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Rafeeq");
  const buf: Buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  return new Uint8Array(buf);
}
