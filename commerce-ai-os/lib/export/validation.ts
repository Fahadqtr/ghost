// INT.2A — shared export validation result model (PURE).
//
// The single validation contract every future destination adapter reports into.
// INT.2A defines the SHAPE + summary only — it implements no platform rule.
// Framework-free; node:test loads it directly.

/** Per-item validation verdict. UNKNOWN = not reliably determinable (never faked). */
export type ExportItemStatus = "READY" | "WARNING" | "BLOCKED" | "UNKNOWN";

/** Structured, deterministic reason codes (fixed set; no free-text data leakage). */
export type ExportReasonCode =
  | "MISSING_SKU"
  | "DUPLICATE_SKU"
  | "MISSING_BARCODE"
  | "DUPLICATE_BARCODE"
  | "INVALID_BARCODE"
  | "MISSING_IMAGE"
  | "IMAGE_SHARED_FROM_PRODUCT"
  | "MISSING_TITLE"
  | "MISSING_PRICE"
  | "MISSING_CATEGORY"
  | "LIFECYCLE_NOT_ELIGIBLE"
  | "IDENTITY_MISSING"
  | "IDENTITY_CONFLICT"
  | "IDENTITY_NEEDS_REVIEW"
  | "VARIANT_NOT_READY"
  | "UNSUPPORTED";

export const EXPORT_REASON_CODES: readonly ExportReasonCode[] = [
  "MISSING_SKU",
  "DUPLICATE_SKU",
  "MISSING_BARCODE",
  "DUPLICATE_BARCODE",
  "INVALID_BARCODE",
  "MISSING_IMAGE",
  "IMAGE_SHARED_FROM_PRODUCT",
  "MISSING_TITLE",
  "MISSING_PRICE",
  "MISSING_CATEGORY",
  "LIFECYCLE_NOT_ELIGIBLE",
  "IDENTITY_MISSING",
  "IDENTITY_CONFLICT",
  "IDENTITY_NEEDS_REVIEW",
  "VARIANT_NOT_READY",
  "UNSUPPORTED",
];

export interface ExportReason {
  code: ExportReasonCode;
  /** true ⇒ blocks export; false ⇒ warning only. */
  blocking: boolean;
  /** optional fixed message (never raw DB text). */
  message?: string;
}

export interface ExportValidationItem {
  /** internal product id (or a sellable-listing id for variant-grain rows). */
  entityId: string;
  destination: string;
  status: ExportItemStatus;
  reasons: readonly ExportReason[];
}

export interface ExportValidationSummary {
  total: number;
  ready: number;
  warnings: number;
  blocked: number;
  unknown: number;
  /** grouped counts per reason code (§7). */
  byReason: Record<string, number>;
}

/** Summarize a set of validation items into the shared summary. Pure + total. */
export function summarizeValidation(
  items: readonly ExportValidationItem[] | null | undefined,
): ExportValidationSummary {
  const summary: ExportValidationSummary = {
    total: 0,
    ready: 0,
    warnings: 0,
    blocked: 0,
    unknown: 0,
    byReason: {},
  };
  if (!Array.isArray(items)) return summary;
  for (const it of items) {
    summary.total++;
    if (it.status === "READY") summary.ready++;
    else if (it.status === "WARNING") summary.warnings++;
    else if (it.status === "BLOCKED") summary.blocked++;
    else summary.unknown++;
    for (const r of it.reasons ?? []) {
      summary.byReason[r.code] = (summary.byReason[r.code] ?? 0) + 1;
    }
  }
  return summary;
}

/** An empty summary — used when a destination's validation is not yet available. */
export const EMPTY_VALIDATION_SUMMARY: ExportValidationSummary = {
  total: 0,
  ready: 0,
  warnings: 0,
  blocked: 0,
  unknown: 0,
  byReason: {},
};
