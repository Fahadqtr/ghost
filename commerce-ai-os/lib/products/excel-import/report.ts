// Catalog Excel import — result report + CSV export (Phase UI.6). Pure.
// The CSV escaper defends against spreadsheet formula injection: any value
// starting with = + - @ (or tab/CR variants) is prefixed with a quote.

export type ImportResultStatus =
  | "product_updated"
  | "variant_updated"
  | "product_created"
  | "variant_created"
  | "skipped"
  | "conflict"
  | "failed"
  | "needs_image"
  | "needs_review"
  | "changed_after_preview";

export const RESULT_LABELS: Record<ImportResultStatus, string> = {
  product_updated: "تم تحديث المنتج",
  variant_updated: "تم تحديث الخيار",
  product_created: "تم إنشاء المنتج",
  variant_created: "تم إنشاء الخيار",
  skipped: "تم التخطي",
  conflict: "تعارض",
  failed: "فشل",
  needs_image: "يحتاج صورة",
  needs_review: "يحتاج مراجعة",
  changed_after_preview: "تغير بعد المعاينة",
};

export interface ImportRecordResult {
  rowNum: number;
  recordKind: "product" | "variant";
  recordId: string | null;
  sku: string | null;
  barcode: string | null;
  status: ImportResultStatus;
  changedFields: string[];
  message: string;
}

export interface ImportReportSummary {
  productUpdated: number;
  variantUpdated: number;
  productCreated: number;
  variantCreated: number;
  skipped: number;
  conflict: number;
  failed: number;
  needsImage: number;
  needsReview: number;
  changedAfterPreview: number;
}

export function buildCatalogImportReport(results: readonly ImportRecordResult[]): ImportReportSummary {
  const s: ImportReportSummary = {
    productUpdated: 0, variantUpdated: 0, productCreated: 0, variantCreated: 0,
    skipped: 0, conflict: 0, failed: 0, needsImage: 0, needsReview: 0, changedAfterPreview: 0,
  };
  for (const r of results) {
    if (r.status === "product_updated") s.productUpdated++;
    else if (r.status === "variant_updated") s.variantUpdated++;
    else if (r.status === "product_created") s.productCreated++;
    else if (r.status === "variant_created") s.variantCreated++;
    else if (r.status === "skipped") s.skipped++;
    else if (r.status === "conflict") s.conflict++;
    else if (r.status === "failed") s.failed++;
    else if (r.status === "needs_image") s.needsImage++;
    else if (r.status === "needs_review") s.needsReview++;
    else if (r.status === "changed_after_preview") s.changedAfterPreview++;
  }
  return s;
}

/** Formula-injection-safe CSV cell. */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

const CSV_HEADERS = ["excel_row", "record_type", "record_id", "sku", "barcode", "status", "changed_fields", "message"];

export function reportToCsv(results: readonly ImportRecordResult[]): string {
  const lines = [CSV_HEADERS.join(",")];
  for (const r of results) {
    lines.push(
      [
        csvCell(r.rowNum),
        csvCell(r.recordKind === "product" ? "منتج رئيسي" : "خيار منتج"),
        csvCell(r.recordId ?? ""),
        csvCell(r.sku ?? ""),
        csvCell(r.barcode ?? ""),
        csvCell(RESULT_LABELS[r.status] ?? r.status),
        csvCell(r.changedFields.join(" | ")),
        csvCell(r.message),
      ].join(","),
    );
  }
  return "﻿" + lines.join("\r\n");
}
