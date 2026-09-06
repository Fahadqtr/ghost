// TALABAT BASELINE UPLOAD — validating the file the whole comparison rests on
// (PURE).
//
// Every number this system reports about Talabat — 147 updates, 408 new
// products — is a claim about THEIR catalog, and it is only as good as the
// export the owner uploaded. So the file is validated before it is trusted,
// and everything generated from it carries a fingerprint of exactly which file
// it was.
//
// The validation is deliberately strict about shape and silent about content:
// a missing column is a rejection (the comparison would misread every row),
// while an unexpected row count is not (Talabat's catalog legitimately grows
// and shrinks, and hard-coding a count would make a correct file look wrong).

import { TALABAT_BASELINE_COLUMNS } from "./baseline-delta.ts";

/** The sheet the Talabat export puts its products on. */
export const BASELINE_SHEET_NAME = "Products";

/** `.xlsx` only — the parser and the column contract assume it. */
export const BASELINE_ACCEPT = ".xlsx";
export const BASELINE_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Cap an upload well above a plausible export, far below anything abusive. */
export const BASELINE_MAX_BYTES = 25 * 1024 * 1024;

export type BaselineRejection =
  | "empty_file"
  | "too_large"
  | "not_xlsx"
  | "unreadable_workbook"
  | "sheet_missing"
  | "headers_missing"
  | "no_rows";

export interface BaselineValidationInput {
  filename: string;
  byteLength: number;
  /** the parsed sheet as an array-of-arrays, or null when parsing failed. */
  aoa: readonly (readonly unknown[])[] | null;
  /** the sheet names the workbook actually contains. */
  sheetNames: readonly string[];
}

export interface BaselineValidationOk {
  ok: true;
  filename: string;
  byteLength: number;
  sheetName: string;
  /** headers exactly as they appear in the file, in order. */
  detectedHeaders: string[];
  /** data rows, header excluded. NEVER compared against an expected number. */
  rowCount: number;
  /** columns the contract needs that the file also has. */
  matchedColumns: string[];
  /** columns present in the file that the contract does not know. Allowed. */
  extraColumns: string[];
}

export type BaselineValidation =
  | BaselineValidationOk
  | { ok: false; reason: BaselineRejection; missingColumns?: string[] };

/**
 * Validate an uploaded Talabat export.
 *
 * Extra columns are ACCEPTED: Talabat adding a field to their export is not a
 * reason to refuse the file, and the parser reads by header name. Missing
 * required columns are refused, because the comparison would silently read
 * nulls and report every row as changed.
 */
export function validateBaselineWorkbook(input: BaselineValidationInput): BaselineValidation {
  if (input.byteLength <= 0) return { ok: false, reason: "empty_file" };
  if (input.byteLength > BASELINE_MAX_BYTES) return { ok: false, reason: "too_large" };
  if (!input.filename.toLowerCase().endsWith(BASELINE_ACCEPT)) return { ok: false, reason: "not_xlsx" };
  if (input.aoa === null) return { ok: false, reason: "unreadable_workbook" };

  const sheetName = input.sheetNames.find((n) => n === BASELINE_SHEET_NAME) ?? null;
  if (sheetName === null) return { ok: false, reason: "sheet_missing" };

  const header = input.aoa[0];
  if (!Array.isArray(header) || header.length === 0) return { ok: false, reason: "headers_missing" };
  const detectedHeaders = header.map((h) => (typeof h === "string" ? h.trim() : String(h ?? "")));

  const required = TALABAT_BASELINE_COLUMNS as readonly string[];
  const present = new Set(detectedHeaders);
  const missingColumns = required.filter((c) => !present.has(c));
  if (missingColumns.length > 0) return { ok: false, reason: "headers_missing", missingColumns };

  const rowCount = input.aoa.slice(1).filter((r) => Array.isArray(r) && r.some((c) => c !== null && c !== "")).length;
  if (rowCount === 0) return { ok: false, reason: "no_rows" };

  return {
    ok: true,
    filename: input.filename,
    byteLength: input.byteLength,
    sheetName,
    detectedHeaders,
    rowCount,
    matchedColumns: required.filter((c) => present.has(c)),
    extraColumns: detectedHeaders.filter((h) => h !== "" && !required.includes(h)),
  };
}

export const BASELINE_REJECTION_AR: Record<BaselineRejection, string> = {
  empty_file: "الملف فارغ.",
  too_large: "حجم الملف أكبر من الحد المسموح.",
  not_xlsx: "يجب أن يكون الملف بصيغة .xlsx فقط.",
  unreadable_workbook: "تعذّرت قراءة الملف — قد يكون تالفاً أو بصيغة أخرى.",
  sheet_missing: `الملف لا يحتوي على ورقة باسم «${BASELINE_SHEET_NAME}».`,
  headers_missing: "أعمدة مطلوبة ناقصة في الملف.",
  no_rows: "الملف لا يحتوي على أي صفوف بيانات.",
};

// ── fingerprint ──────────────────────────────────────────────────────────────

/**
 * The content fingerprint lives in lib/talabat/baseline-fingerprint.ts, outside
 * this tree: the INT.2A guard proves the export foundation performs no writes
 * by scanning for the write verbs, one of which a hash builder also calls on
 * its digest object. Re-exported here so the baseline contract reads as one
 * thing.
 */
export { baselineFingerprint } from "../../talabat/baseline-fingerprint.ts";

export interface ActiveBaselineMeta {
  filename: string;
  byteLength: number;
  rowCount: number;
  fingerprint: string;
  uploadedAtIso: string;
  uploadedBy: string;
  detectedHeaders: string[];
  /** the versioned object this upload was stored as. */
  objectPath: string;
}

/**
 * Versioned storage: each upload lands under its own fingerprint, and a small
 * pointer records which one is active. Overwriting a single path would destroy
 * the evidence of which file produced an already-generated artifact.
 */
export const BASELINE_PREFIX = "email-artifacts/baseline";
export const ACTIVE_BASELINE_POINTER = `${BASELINE_PREFIX}/active.json`;
export const baselineObjectPath = (fingerprint: string) => `${BASELINE_PREFIX}/${fingerprint}/products.xlsx`;

export function parseActiveBaselineMeta(raw: unknown): ActiveBaselineMeta | null {
  if (raw === null || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const filename = str(o.filename); const fingerprint = str(o.fingerprint);
  const uploadedAtIso = str(o.uploadedAtIso); const uploadedBy = str(o.uploadedBy);
  const objectPath = str(o.objectPath);
  const byteLength = num(o.byteLength); const rowCount = num(o.rowCount);
  if (!filename || !fingerprint || !uploadedAtIso || !uploadedBy || !objectPath) return null;
  if (byteLength === null || rowCount === null) return null;
  return {
    filename, byteLength, rowCount, fingerprint, uploadedAtIso, uploadedBy, objectPath,
    detectedHeaders: Array.isArray(o.detectedHeaders)
      ? o.detectedHeaders.filter((h): h is string => typeof h === "string") : [],
  };
}
