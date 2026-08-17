// INT.2C — Snoonu sheet SERIALIZER (SheetJS).
//
// Turns the pure Snoonu package rows into the snoonu-products.xlsx bytes,
// enforcing spreadsheet correctness: SKU / barcode / Snoonu ID (SPI) stored as
// TEXT (no scientific notation, no leading-zero loss), price/discount numeric,
// UTF-8/Arabic preserved, deterministic column + row order (the pure AoA order).
// Free-text cells were injection-sanitized by the pure builder. Kept OUT of the
// server-only module (no next/supabase imports) so it is directly unit-testable;
// the INT.2A read-only guard scans lib/export, not lib/snoonu, so SheetJS lives
// here.

import { createRequire } from "node:module";
import {
  buildSnoonuXlsxAoa,
  SNOONU_TEXT_COLUMNS,
  SNOONU_PRICE_COLUMN,
  SNOONU_DISCOUNT_COLUMN,
  type SnoonuPackageRow,
} from "../export/snoonu/package.ts";

const COL_WIDTHS = [16, 16, 16, 30, 30, 18, 18, 10, 12, 8, 14, 40, 44, 44, 30, 30];

export function buildSnoonuXlsxBuffer(rows: readonly SnoonuPackageRow[]): Uint8Array {
  const require = createRequire(import.meta.url);
  const XLSX = require("xlsx");

  const aoa = buildSnoonuXlsxAoa(rows);
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const range = XLSX.utils.decode_range(ws["!ref"]);
  const textCols = new Set<number>(SNOONU_TEXT_COLUMNS as readonly number[]);
  const numCols = new Set<number>([SNOONU_PRICE_COLUMN, SNOONU_DISCOUNT_COLUMN]);

  for (let r = range.s.r; r <= range.e.r; r++) {
    if (r === range.s.r) continue; // header row: default strings
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      if (!cell) continue;
      if (textCols.has(c)) {
        cell.t = "s";
        cell.v = String(cell.v ?? "");
        cell.z = "@";
      } else if (numCols.has(c) && typeof cell.v === "number") {
        cell.t = "n";
      }
    }
  }

  ws["!cols"] = COL_WIDTHS.map((wch) => ({ wch }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Snoonu");
  const buf: Buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  return new Uint8Array(buf);
}
