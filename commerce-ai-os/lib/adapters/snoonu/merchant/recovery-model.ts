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

import type { DiscoveryCandidate, DiscoveryClassification } from "./discovery-contract.ts";

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
