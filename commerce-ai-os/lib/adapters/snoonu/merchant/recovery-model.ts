// MEDIA.1C — Snoonu image-recovery decision model (PURE).
//
// Decides whether ONE product may recover ONE image from ONE storefront's
// discovery result. The rules mirror the certified pipeline exactly:
//   • only a CONNECTED storefront session may recover;
//   • a product that already has a canonical primary image is NEVER overwritten;
//   • SAFE_MATCH (single exact barcode/SKU identity) may recover on one confirm;
//   • NEEDS_REVIEW (any name-based or multi-candidate match) recovers ONLY with
//     an explicit operator-selected candidate (confirmedSpi) — never automatically;
//   • the selected candidate must still exist in the FRESH discovery result and
//     must carry an image URL, otherwise the preview is stale / has no source.
// This module holds NO IO — the server orchestrator feeds it fresh facts.
//
// PURE: relative type imports only; no server-only, no env, no network, no clock.

import type { DiscoveryCandidate, DiscoveryClassification, DiscoveryResult } from "./discovery-contract.ts";
import { REASON_LABEL } from "./discovery-contract.ts";
import type { ApplyItemResult, ImagePreviewRow, SearchModeTrace } from "./merchant-contract.ts";

export type RecoveryStatus =
  | "RECOVERED"
  | "UNCHANGED"
  | "NEEDS_REVIEW"
  | "NO_MATCH"
  | "NO_IMAGE_SOURCE"
  | "SESSION_REQUIRED"
  | "STALE"
  | "FAILED";

export const RECOVERY_STATUS_LABEL: Record<RecoveryStatus, string> = {
  RECOVERED: "تم الاستيراد",
  UNCHANGED: "لديه صورة بالفعل",
  NEEDS_REVIEW: "تحتاج مراجعة",
  NO_MATCH: "لم يتم العثور",
  NO_IMAGE_SOURCE: "لا توجد صورة في المصدر",
  SESSION_REQUIRED: "الجلسة مطلوبة",
  STALE: "تغيّرت النتيجة — أعد البحث",
  FAILED: "فشل",
};

/** The final, safe outcome of one recovery attempt (never carries secrets). */
export interface RecoveryOutcome {
  status: RecoveryStatus;
  /** Safe human-readable reason (Arabic; detail logged server-side only). */
  reason: string;
  /** Our permanent stored URL — present only on RECOVERED. */
  url?: string;
}

export interface RecoveryDecisionInput {
  /** Fresh re-read immediately before write: product already has a primary image. */
  hasPrimaryImage: boolean;
  /** The storefront's session proved CONNECTED by a real authenticated read. */
  sessionConnected: boolean;
  /** FRESH discovery classification for this storefront. */
  classification: DiscoveryClassification;
  /** FRESH candidates for this storefront. */
  candidates: DiscoveryCandidate[];
  /**
   * The operator-selected candidate SPI. REQUIRED for NEEDS_REVIEW (explicit
   * confirmation); for SAFE_MATCH it additionally pins identity — when provided
   * it must match the fresh single candidate or the preview is stale.
   */
  confirmedSpi: string | null;
}

export type RecoveryDecision =
  | { allow: true; candidate: DiscoveryCandidate }
  | { allow: false; status: Exclude<RecoveryStatus, "RECOVERED">; reason: string };

const has = (v: string | null | undefined): v is string => typeof v === "string" && v.trim() !== "";

export function decideSnoonuRecovery(input: RecoveryDecisionInput): RecoveryDecision {
  if (!input.sessionConnected) {
    return { allow: false, status: "SESSION_REQUIRED", reason: "جلسة المتجر غير متصلة — لا استرجاع بدون جلسة مُثبتة." };
  }
  // Never overwrite an existing primary image — checked against the FRESH read.
  if (input.hasPrimaryImage) {
    return { allow: false, status: "UNCHANGED", reason: "المنتج لديه صورة أساسية بالفعل — لم تُستبدل." };
  }

  switch (input.classification) {
    case "SESSION_REQUIRED":
      return { allow: false, status: "SESSION_REQUIRED", reason: "الجلسة مطلوبة للبحث في هذا المتجر." };
    case "ERROR":
      return { allow: false, status: "FAILED", reason: "تعذّر البحث في Snoonu — حاول مجددًا." };
    case "NO_MATCH":
      return { allow: false, status: "NO_MATCH", reason: "لا توجد نتيجة مطابقة في هذا المتجر." };
    case "SAFE_MATCH": {
      const candidate = input.candidates[0];
      if (!candidate) return { allow: false, status: "STALE", reason: "النتيجة لم تعد موجودة — أعد البحث." };
      // Identity pin: when the UI sent the previewed SPI it must still match.
      if (input.confirmedSpi !== null && candidate.spi !== input.confirmedSpi) {
        return { allow: false, status: "STALE", reason: "تغيّرت نتيجة المطابقة منذ المعاينة — أعد البحث." };
      }
      if (!has(candidate.imageUrl)) {
        return { allow: false, status: "NO_IMAGE_SOURCE", reason: "المطابقة موجودة لكن بلا صورة في المصدر." };
      }
      return { allow: true, candidate };
    }
    case "NEEDS_REVIEW": {
      // Name-based / multi-candidate matches NEVER auto-recover: an explicit
      // operator-selected candidate is required.
      if (!has(input.confirmedSpi)) {
        return { allow: false, status: "NEEDS_REVIEW", reason: "المطابقة غير مؤكدة — اختر النتيجة الصحيحة يدويًا أولًا." };
      }
      const candidate = input.candidates.find((c) => c.spi === input.confirmedSpi);
      if (!candidate) {
        return { allow: false, status: "STALE", reason: "النتيجة المختارة لم تعد موجودة — أعد البحث واختر مجددًا." };
      }
      if (!has(candidate.imageUrl)) {
        return { allow: false, status: "NO_IMAGE_SOURCE", reason: "النتيجة المختارة بلا صورة في المصدر." };
      }
      return { allow: true, candidate };
    }
  }
}

/**
 * MEDIA.1C-HOTFIX2 — map ONE product's LIVE discovery result to the Media
 * Center's CH.6B-shaped preview row (pure). The batch scan previously ran
 * through the legacy SnoonuMerchantSession SPI port, whose state() is a
 * hardcoded session_required no-op — so it always reported SESSION_REQUIRED
 * regardless of the provisioned session. Rows are now derived from the SAME
 * live discovery pipeline the per-product page uses. Only MATCHED rows with a
 * source image are selectable (bulk applies SAFE matches only).
 */
/** What the live adapter emits per lookup (term included for attribution). */
export interface EmittedLookupTrace {
  mode: "barcode" | "sku" | "name";
  term: string;
  read: "ok" | "unauthorized" | "timeout" | "error";
  rawCount: number;
  exactCount: number;
}

/**
 * MEDIA.1C-HOTFIX3 — assemble the per-mode evidence for ONE candidate from the
 * adapter's emitted lookups (pure). A mode with no term, or one the engine
 * never reached (an earlier mode SAFE-matched), is attempted:false / skipped.
 * Attribution is by (mode, term); memoized reads re-emit, so the first match
 * carries the true counts for this candidate's term.
 */
export function buildRowModeTrace(
  product: { barcode: string | null; sku: string | null; name: string | null },
  emitted: EmittedLookupTrace[],
): SearchModeTrace[] {
  const forMode = (mode: SearchModeTrace["mode"], term: string | null): SearchModeTrace => {
    const t = term && term.trim() !== "" ? term : null;
    const hit = t ? emitted.find((e) => e.mode === mode && e.term === t) : undefined;
    if (!t || !hit) return { mode, attempted: false, read: "skipped", rawCount: 0, exactCount: 0 };
    return { mode, attempted: true, read: hit.read, rawCount: hit.rawCount, exactCount: hit.exactCount };
  };
  return [forMode("barcode", product.barcode), forMode("sku", product.sku), forMode("name", product.name)];
}

const TRACE_MODE_LABEL: Record<SearchModeTrace["mode"], string> = { barcode: "باركود", sku: "SKU", name: "اسم" };
const TRACE_READ_LABEL: Record<SearchModeTrace["read"], string> = {
  ok: "نجح", unauthorized: "مرفوض", timeout: "مهلة", error: "خطأ", skipped: "تخطّي",
};

/** Compact per-mode evidence suffix appended to a row's reason (pure). */
export function formatModeTraceReason(trace: SearchModeTrace[]): string {
  const parts = trace.map((t) =>
    t.attempted
      ? `${TRACE_MODE_LABEL[t.mode]}: ${TRACE_READ_LABEL[t.read]} خام ${t.rawCount} تام ${t.exactCount}`
      : `${TRACE_MODE_LABEL[t.mode]}: ${TRACE_READ_LABEL.skipped}`,
  );
  return `[${parts.join(" · ")}]`;
}

export function discoveryResultToPreviewRow(
  product: { id: string; sku: string | null; barcode: string | null },
  r: DiscoveryResult,
  modeTrace?: SearchModeTrace[],
): ImagePreviewRow {
  const best = r.candidates[0] ?? null;
  let matchStatus: ImagePreviewRow["matchStatus"];
  let reason: string;
  let selectable = false;

  switch (r.classification) {
    case "SESSION_REQUIRED":
      matchStatus = "SESSION_REQUIRED";
      reason = "الجلسة مطلوبة للبحث في Snoonu.";
      break;
    case "ERROR":
      matchStatus = "NEEDS_REVIEW";
      reason = "خطأ أثناء البحث — أعد المحاولة.";
      break;
    case "NO_MATCH":
      matchStatus = "NOT_FOUND";
      reason = "لا توجد نتيجة مطابقة في هذا المتجر.";
      break;
    case "SAFE_MATCH":
      if (best && has(best.imageUrl)) {
        matchStatus = "MATCHED";
        reason = `تطابق مؤكد (${REASON_LABEL[r.matchReason]}).`;
        selectable = true;
      } else {
        matchStatus = "NEEDS_REVIEW";
        reason = "مطابقة مؤكدة لكن بلا صورة في المصدر.";
      }
      break;
    case "NEEDS_REVIEW":
      matchStatus = "NEEDS_REVIEW";
      reason = `تحتاج مراجعة (${REASON_LABEL[r.matchReason]}).`;
      break;
  }

  return {
    productId: product.id,
    sku: product.sku,
    barcode: product.barcode,
    storefrontKey: r.storefrontKey,
    spi: best?.spi ?? null,
    currentImage: false, // batch candidates are, by construction, missing their primary image
    merchantImageUrl: best?.imageUrl ?? null,
    matchStatus,
    reason: modeTrace ? `${reason} ${formatModeTraceReason(modeTrace)}` : reason,
    modeTrace,
    provenance: {
      storefrontKey: r.storefrontKey,
      spi: best?.spi ?? null,
      merchantSku: best?.sku ?? null,
      merchantBarcode: best?.barcode ?? null,
      merchantTitle: best?.name ?? null,
      internalProductId: product.id,
      confidence: matchStatus === "MATCHED" ? "high" : matchStatus === "NEEDS_REVIEW" && best ? "medium" : "none",
    },
    selectable,
  };
}

/** SNOONU.IDENTITY.1 — a catalog item with no active storefront SPI is not a portal search miss. */
export function unlinkedProductToPreviewRow(
  product: { id: string; sku: string | null; barcode: string | null },
  storefrontKey: ImagePreviewRow["storefrontKey"],
): ImagePreviewRow {
  return {
    productId: product.id,
    sku: product.sku,
    barcode: product.barcode,
    storefrontKey,
    spi: null,
    currentImage: false,
    merchantImageUrl: null,
    matchStatus: "UNLINKED",
    reason: "المنتج غير مرتبط بهذا المتجر في Snoonu — لم يُرسل للبحث أو الاسترجاع.",
    provenance: {
      storefrontKey,
      spi: null,
      merchantSku: null,
      merchantBarcode: null,
      merchantTitle: null,
      internalProductId: product.id,
      confidence: "none",
    },
    selectable: false,
  };
}

/** MEDIA.1C-HOTFIX2 — map one recovery outcome to the Media Center's apply-result shape (pure). */
export function recoveryOutcomeToApplyResult(productId: string, o: RecoveryOutcome): ApplyItemResult {
  if (o.status === "RECOVERED") return { productId, status: "IMPORTED", url: o.url };
  if (o.status === "UNCHANGED" || o.status === "STALE") return { productId, status: "SKIPPED", reason: o.reason };
  if (o.status === "NEEDS_REVIEW") return { productId, status: "NEEDS_REVIEW", reason: o.reason };
  return { productId, status: "FAILED", reason: o.reason };
}
