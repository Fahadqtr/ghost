// Catalog Excel import — server-side workbook parsing (Phase UI.6).
// server-only; the xlsx module (SheetJS 0.20.3, already a dependency used by
// the legacy import flows) is lazily imported and injectable for node tests.
//
// Safety posture:
// - the caller has already verified size + ZIP magic bytes;
// - formulas are NEVER evaluated — SheetJS only exposes the cached value, and
//   we additionally count formula cells so the UI can warn;
// - raw cell values are used (never Excel's formatted text), so numeric
//   barcodes cannot degrade into scientific notation;
// - hard row cap: files beyond MAX_IMPORT_ROWS are rejected, not truncated;
// - extraction is SPARSE: it walks the cells that actually exist instead of
//   materializing the sheet's declared range. Platform exports (Snoonu-style
//   AllExportData) often declare a dimension like A1:R1048576 while holding a
//   thousand real rows — a dense reader allocates the whole million-row grid
//   (measured: ~14s CPU and ~0.5GB heap for a 33KB file) and kills the
//   request. Walking real cells is O(data) regardless of the declared range.

import "server-only";

export const MAX_IMPORT_ROWS = 5000;
export const MAX_IMPORT_BYTES = 15 * 1024 * 1024;
export const MAX_IMPORT_COLUMNS = 200;

interface XlsxModule {
  read(data: Buffer, opts: Record<string, unknown>): {
    SheetNames: string[];
    Sheets: Record<string, Record<string, unknown>>;
  };
  utils: {
    decode_cell(addr: string): { r: number; c: number };
  };
}

async function resolveXlsx(injected?: XlsxModule): Promise<XlsxModule> {
  if (injected) return injected;
  const m = await import("xlsx");
  return m as unknown as XlsxModule;
}

interface SparseSheet {
  /** row index -> (col index -> raw cell value) for cells that really exist */
  rows: Map<number, Map<number, unknown>>;
  maxCol: number;
  formulaCells: number;
}

function isEmptyCellValue(v: unknown): boolean {
  return v === null || v === undefined || v === "";
}

/** Walk the cells that actually exist — never the declared !ref grid. */
function readSparseSheet(
  sheet: Record<string, unknown>,
  X: XlsxModule,
): SparseSheet | { error: "too_many_columns" } {
  const rows = new Map<number, Map<number, unknown>>();
  let maxCol = -1;
  let formulaCells = 0;
  for (const key of Object.keys(sheet)) {
    if (key.startsWith("!")) continue;
    const cell = sheet[key] as { v?: unknown; f?: unknown } | null;
    if (!cell || typeof cell !== "object") continue;
    if (typeof cell.f === "string") formulaCells++;
    const v = "v" in cell ? cell.v : undefined;
    if (v === undefined) continue;
    let addr: { r: number; c: number };
    try {
      addr = X.utils.decode_cell(key);
    } catch {
      continue;
    }
    if (addr.c >= MAX_IMPORT_COLUMNS) return { error: "too_many_columns" };
    if (addr.c > maxCol) maxCol = addr.c;
    let row = rows.get(addr.r);
    if (!row) {
      row = new Map<number, unknown>();
      rows.set(addr.r, row);
    }
    row.set(addr.c, v);
  }
  return { rows, maxCol, formulaCells };
}

/** data rows (header excluded) that hold at least one non-empty value. */
function countDataRows(sparse: SparseSheet): number {
  let count = 0;
  for (const [r, cells] of sparse.rows) {
    if (r === 0) continue;
    for (const v of cells.values()) {
      if (!isEmptyCellValue(v)) {
        count++;
        break;
      }
    }
  }
  return count;
}

export interface SheetInfo {
  name: string;
  rows: number; // REAL non-empty data rows (header row excluded)
}

export type InspectResult =
  | { status: "ok"; sheets: SheetInfo[] }
  | { status: "error"; code: "unreadable" | "empty" };

export async function inspectWorkbook(bytes: Buffer, xlsx?: XlsxModule): Promise<InspectResult> {
  try {
    const X = await resolveXlsx(xlsx);
    const wb = X.read(bytes, { type: "buffer", cellHTML: false, cellStyles: false });
    const sheets: SheetInfo[] = [];
    for (const name of wb.SheetNames) {
      const sheet = wb.Sheets[name];
      if (!sheet || typeof sheet !== "object") {
        sheets.push({ name, rows: 0 });
        continue;
      }
      const sparse = readSparseSheet(sheet, X);
      sheets.push({ name, rows: "error" in sparse ? 0 : countDataRows(sparse) });
    }
    if (sheets.length === 0) return { status: "error", code: "empty" };
    return { status: "ok", sheets };
  } catch {
    return { status: "error", code: "unreadable" };
  }
}

export type ExtractResult =
  | {
      status: "ok";
      headers: unknown[];
      rows: unknown[][]; // raw values, header row excluded, empty rows dropped
      /** true Excel row number (1-based) for each entry of `rows` */
      rowNums: number[];
      formulaCells: number;
    }
  | { status: "error"; code: "unreadable" | "sheet_not_found" | "empty" | "too_many_rows" | "too_many_columns" };

export async function extractSheetRows(
  bytes: Buffer,
  sheetName: string,
  xlsx?: XlsxModule,
): Promise<ExtractResult> {
  try {
    const X = await resolveXlsx(xlsx);
    const wb = X.read(bytes, { type: "buffer", cellHTML: false, cellStyles: false });
    const sheet = wb.Sheets[sheetName];
    if (!sheet) return { status: "error", code: "sheet_not_found" };

    const sparse = readSparseSheet(sheet, X);
    if ("error" in sparse) return { status: "error", code: "too_many_columns" };
    if (sparse.rows.size === 0 || sparse.maxCol < 0) return { status: "error", code: "empty" };

    const width = sparse.maxCol + 1;
    const toDense = (cells: Map<number, unknown>): unknown[] => {
      const out: unknown[] = new Array(width).fill(null);
      for (const [c, v] of cells) out[c] = v === undefined ? null : v;
      return out;
    };

    const headerCells = sparse.rows.get(0);
    const headers = headerCells ? toDense(headerCells) : new Array(width).fill(null);

    const dataRowIndexes = [...sparse.rows.keys()].filter((r) => r !== 0).sort((a, b) => a - b);
    const rows: unknown[][] = [];
    const rowNums: number[] = [];
    for (const r of dataRowIndexes) {
      const cells = sparse.rows.get(r)!;
      let hasValue = false;
      for (const v of cells.values()) {
        if (!isEmptyCellValue(v)) {
          hasValue = true;
          break;
        }
      }
      if (!hasValue) continue; // fully-empty row → dropped, exactly as before
      if (rows.length >= MAX_IMPORT_ROWS) return { status: "error", code: "too_many_rows" };
      rows.push(toDense(cells));
      rowNums.push(r + 1); // 1-based Excel row number (header is row 1)
    }
    if (rows.length === 0) return { status: "error", code: "empty" };
    return { status: "ok", headers, rows, rowNums, formulaCells: sparse.formulaCells };
  } catch {
    return { status: "error", code: "unreadable" };
  }
}

/** XLSX files are ZIP containers — PK\x03\x04. (.xls/.xlsm are rejected.) */
export function looksLikeXlsx(bytes: Buffer): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}
