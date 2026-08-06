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
// - hard row cap: files beyond MAX_IMPORT_ROWS are rejected, not truncated.

import "server-only";

export const MAX_IMPORT_ROWS = 5000;
export const MAX_IMPORT_BYTES = 15 * 1024 * 1024;

interface XlsxModule {
  read(data: Buffer, opts: Record<string, unknown>): {
    SheetNames: string[];
    Sheets: Record<string, Record<string, unknown>>;
  };
  utils: {
    decode_range(ref: string): { s: { r: number; c: number }; e: { r: number; c: number } };
    sheet_to_json(sheet: unknown, opts: Record<string, unknown>): unknown[][];
  };
}

async function resolveXlsx(injected?: XlsxModule): Promise<XlsxModule> {
  if (injected) return injected;
  const m = await import("xlsx");
  return m as unknown as XlsxModule;
}

export interface SheetInfo {
  name: string;
  rows: number; // data rows (excluding the header row), approximate from !ref
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
      const ref = sheet && typeof sheet["!ref"] === "string" ? (sheet["!ref"] as string) : null;
      let rows = 0;
      if (ref) {
        try {
          const range = X.utils.decode_range(ref);
          rows = Math.max(0, range.e.r); // minus the header row
        } catch {
          rows = 0;
        }
      }
      sheets.push({ name, rows });
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
      rows: unknown[][]; // raw values, header row excluded
      formulaCells: number;
    }
  | { status: "error"; code: "unreadable" | "sheet_not_found" | "empty" | "too_many_rows" };

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

    let formulaCells = 0;
    for (const key of Object.keys(sheet)) {
      if (key.startsWith("!")) continue;
      const cell = sheet[key] as { f?: unknown } | null;
      if (cell && typeof cell === "object" && typeof cell.f === "string") formulaCells++;
    }

    const aoa = X.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null }) as unknown[][];
    if (aoa.length === 0) return { status: "error", code: "empty" };
    const headers = aoa[0] ?? [];
    const rows = aoa.slice(1).filter((r) => Array.isArray(r) && r.some((c) => c !== null && c !== ""));
    if (rows.length === 0) return { status: "error", code: "empty" };
    if (rows.length > MAX_IMPORT_ROWS) return { status: "error", code: "too_many_rows" };
    return { status: "ok", headers, rows, formulaCells };
  } catch {
    return { status: "error", code: "unreadable" };
  }
}

/** XLSX files are ZIP containers — PK\x03\x04. (.xls/.xlsm are rejected.) */
export function looksLikeXlsx(bytes: Buffer): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}
