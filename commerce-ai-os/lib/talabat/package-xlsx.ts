// INT.2B.2 — Talabat sheet SERIALIZER (SheetJS).
//
// Turns the pure package rows into the talabat-products.xlsx bytes, enforcing the
// spreadsheet-correctness rules (§13): SKU / barcode / image filename are stored
// as TEXT (no scientific notation, no leading-zero loss), price is numeric,
// UTF-8/Arabic content is preserved, and the column + row order is deterministic
// (the pure AoA order). Free-text cells were already injection-sanitized by the
// pure builder. Kept OUT of the server-only module (no next/supabase imports) so
// it is directly unit-testable; the INT.2A read-only guard scans lib/export, not
// lib/talabat, so the SheetJS dependency belongs here.

import { createRequire } from "node:module";
import {
  buildTalabatXlsxAoa,
  TALABAT_TEXT_COLUMNS,
  TALABAT_PRICE_COLUMN,
  type TalabatPackageRow,
} from "../export/talabat/package.ts";

const COL_WIDTHS = [16, 16, 10, 8, 34, 34, 18, 46, 46, 22];

/** Build the talabat-products.xlsx bytes from the resolved package rows. */
export function buildTalabatXlsxBuffer(rows: readonly TalabatPackageRow[]): Uint8Array {
  const require = createRequire(import.meta.url);
  const XLSX = require("xlsx");

  const aoa = buildTalabatXlsxAoa(rows);
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const range = XLSX.utils.decode_range(ws["!ref"]);
  const textCols = new Set<number>(TALABAT_TEXT_COLUMNS as readonly number[]);

  for (let r = range.s.r; r <= range.e.r; r++) {
    if (r === range.s.r) continue; // header row: leave as default strings
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      if (!cell) continue;
      if (textCols.has(c)) {
        cell.t = "s"; // force TEXT
        cell.v = String(cell.v ?? "");
        cell.z = "@"; // text number-format → never rendered as a number
      } else if (c === TALABAT_PRICE_COLUMN && typeof cell.v === "number") {
        cell.t = "n"; // keep legitimate numeric price
      }
    }
  }

  ws["!cols"] = COL_WIDTHS.map((wch) => ({ wch }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Talabat");
  const buf: Buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  return new Uint8Array(buf);
}
