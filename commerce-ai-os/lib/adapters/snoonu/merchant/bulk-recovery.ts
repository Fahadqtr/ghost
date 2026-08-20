// MEDIA.2 — Bulk Snoonu image recovery model (PURE).
//
// The bulk operation is CLIENT-ORCHESTRATED selection + reporting around the
// certified per-product pipeline: each selected product independently runs the
// existing MEDIA.1C recovery flow (writer gate → session re-check → fresh
// product read → fresh discovery → decision → certified media boundary), one
// product per server-action call, so one failure never aborts the batch and
// cancel takes effect after the current product. This module holds the pure
// helpers only — which scan rows are bulk-eligible, which belong in the review
// queue, the final report aggregation, the progress/ETA math, and the CSV
// export. It duplicates NO matching, eligibility, or write logic: eligibility
// comes from the scan rows the MEDIA.1B engine classified (selectable ⇔
// SAFE_MATCH with a source image), and the write decision stays inside the
// MEDIA.1C orchestrator.
//
// PURE: relative type imports only; no server-only, no env, no network, no clock.

import type { ImagePreviewRow, ImagePreviewSummary } from "./merchant-contract.ts";
import type { RecoveryStatus } from "./recovery-model.ts";
import { RECOVERY_STATUS_LABEL } from "./recovery-model.ts";

/** One product's outcome in a bulk run (safe fields only — never secrets). */
export interface BulkItemResult {
  productId: string;
  sku: string | null;
  status: RecoveryStatus;
  reason: string;
  /** Our permanent stored URL — present only on RECOVERED. */
  url?: string;
}

/** The final bulk report, in the operator's own categories. */
export interface BulkReport {
  total: number;
  recovered: number; //        RECOVERED
  alreadyHadImage: number; //  UNCHANGED (fresh read found a primary image)
  skipped: number; //          STALE (result changed since preview — nothing written)
  needsReview: number; //      NEEDS_REVIEW (never auto-applied)
  sessionExpired: number; //   SESSION_REQUIRED (session died — nothing written)
  failed: number; //           NO_MATCH / NO_IMAGE_SOURCE / FAILED
}

export const BULK_REPORT_LABEL: Record<Exclude<keyof BulkReport, "total">, string> = {
  recovered: "مسترجَع",
  alreadyHadImage: "لديه صورة بالفعل",
  skipped: "متجاوَز",
  needsReview: "بحاجة مراجعة",
  sessionExpired: "انتهت الجلسة",
  failed: "فشل",
};

/** Which report bucket one recovery status lands in. */
export function bulkReportKey(status: RecoveryStatus): Exclude<keyof BulkReport, "total"> {
  switch (status) {
    case "RECOVERED":
      return "recovered";
    case "UNCHANGED":
      return "alreadyHadImage";
    case "STALE":
      return "skipped";
    case "NEEDS_REVIEW":
      return "needsReview";
    case "SESSION_REQUIRED":
      return "sessionExpired";
    default:
      return "failed"; // NO_MATCH / NO_IMAGE_SOURCE / FAILED
  }
}

export function summarizeBulk(results: readonly BulkItemResult[]): BulkReport {
  const report: BulkReport = {
    total: 0, recovered: 0, alreadyHadImage: 0, skipped: 0, needsReview: 0, sessionExpired: 0, failed: 0,
  };
  for (const r of Array.isArray(results) ? results : []) {
    report.total += 1;
    report[bulkReportKey(r.status)] += 1;
  }
  return report;
}

const has = (v: string | null | undefined): v is string => typeof v === "string" && v.trim() !== "";

/**
 * The ONLY rows a bulk recovery may act on: rows the untouched MEDIA.1B engine
 * classified SAFE_MATCH with a source image (selectable), carrying the SPI that
 * pins identity per item (stale protection inside MEDIA.1C). NEEDS_REVIEW rows
 * are structurally excluded — they live in the review queue and recover only on
 * an explicit per-product confirmation.
 */
export function safeRecoveryRows(rows: readonly ImagePreviewRow[]): ImagePreviewRow[] {
  return (Array.isArray(rows) ? rows : []).filter(
    (r) => r.selectable && r.matchStatus === "MATCHED" && has(r.spi) && has(r.merchantImageUrl),
  );
}

/** Rows for the review queue: ambiguous / name-based — never bulk-recovered. */
export function reviewQueueRows(rows: readonly ImagePreviewRow[]): ImagePreviewRow[] {
  return (Array.isArray(rows) ? rows : []).filter((r) => r.matchStatus === "NEEDS_REVIEW");
}

/** Arabic-first top summary, e.g. «58 ناقصة · 34 آمنة · 18 مراجعة · 6 غير موجود». */
export function buildScanSummaryLine(summary: ImagePreviewSummary): string {
  const parts = [
    `${summary.missing} ناقصة`,
    `${summary.matched} آمنة`,
    `${summary.needsReview} مراجعة`,
    `${summary.notFound} غير موجود`,
  ];
  if (summary.sessionRequired > 0) parts.push(`${summary.sessionRequired} بحاجة جلسة`);
  return parts.join(" · ");
}

/** Live progress line, e.g. «جارٍ الاسترجاع… 23/58 · الحالي: mk2245». */
export function buildProgressLine(done: number, total: number, currentSku: string | null): string {
  const base = `جارٍ الاسترجاع… ${done}/${total}`;
  return has(currentSku) ? `${base} · الحالي: ${currentSku}` : base;
}

/**
 * Naive linear ETA from elapsed time. Null until the first item completes
 * (no basis for an estimate) and when the run is already done.
 */
export function estimateRemainingMs(elapsedMs: number, done: number, total: number): number | null {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || done <= 0 || total <= done) return null;
  return Math.round((elapsedMs / done) * (total - done));
}

/** Compact Arabic duration, e.g. «~3 د 20 ث» / «~45 ث». */
export function formatDurationAr(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `~${minutes} د ${seconds} ث` : `~${seconds} ث`;
}

const csvCell = (v: string): string => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/**
 * CSV export of the final report (header + one row per product). The caller
 * prepends the UTF-8 BOM when saving so Arabic text opens correctly in Excel.
 */
export function buildBulkCsv(results: readonly BulkItemResult[]): string {
  const lines = ["product_id,sku,status,status_label,reason,url"];
  const list: readonly BulkItemResult[] = Array.isArray(results) ? results : [];
  for (const r of list) {
    lines.push(
      [r.productId, r.sku ?? "", r.status, RECOVERY_STATUS_LABEL[r.status], r.reason, r.url ?? ""]
        .map(csvCell)
        .join(","),
    );
  }
  return lines.join("\n");
}
