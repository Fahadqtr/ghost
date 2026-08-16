// CH.6F — per-unit classification helpers (import eligibility, publish
// readiness, human-readable evidence). PURE. No `@/` imports, no server-only.

import { type Grain, type ImportEligibility, type PublishReadiness, type MatchEvidenceKind } from "./discovery-model.ts";
import { isValidBarcode, normalizeSku } from "./discovery-match.ts";

export interface ExternalCandidate {
  title: string | null;
  sku: string | null;
  barcode: string | null;
  externalId: string | null;
  grain: Grain;
}

/**
 * IMPORT_ELIGIBLE requires enough AUTHORITATIVE data to create a minimally valid
 * internal product WITHOUT fabrication (§10): a title AND at least one durable
 * identity key (a SKU or a valid barcode). Anything less is INSUFFICIENT_DATA.
 * (An ambiguous internal resolution is decided as NEEDS_REVIEW by the assembler.)
 */
export function importEligibility(c: ExternalCandidate): ImportEligibility {
  const hasTitle = typeof c.title === "string" && c.title.trim().length >= 2;
  const hasSku = normalizeSku(c.sku) != null;
  const hasBarcode = isValidBarcode(c.barcode);
  if (!hasTitle) return "INSUFFICIENT_DATA";
  if (!hasSku && !hasBarcode) return "INSUFFICIENT_DATA";
  return "IMPORT_ELIGIBLE";
}

/** The concrete reasons an external candidate is not importable (for the UI). */
export function insufficientReasons(c: ExternalCandidate): string[] {
  const out: string[] = [];
  if (!(typeof c.title === "string" && c.title.trim().length >= 2)) out.push("title");
  if (normalizeSku(c.sku) == null && !isValidBarcode(c.barcode)) out.push("sku_or_barcode");
  return out;
}

export interface ReadinessFacts {
  hasBarcode: boolean;
  hasImage: boolean;
  hasTitle: boolean;
  hasDescription: boolean;
}

/**
 * INTERNAL_ONLY readiness (§9). CH.6F does NOT publish; it only reports whether
 * the data an adapter would need is present. READY_TO_PUBLISH ⇔ no blockers.
 * Identity is deliberately NOT a blocker: INTERNAL_ONLY means no listing yet, so
 * a publish flow would create the identity — not a precondition to prepare.
 */
export function publishReadiness(f: ReadinessFacts): { readiness: PublishReadiness; blockers: string[] } {
  const blockers: string[] = [];
  if (!f.hasTitle) blockers.push("title");
  if (!f.hasBarcode) blockers.push("barcode");
  if (!f.hasImage) blockers.push("image");
  if (!f.hasDescription) blockers.push("description");
  return { readiness: blockers.length === 0 ? "READY_TO_PUBLISH" : "BLOCKED", blockers };
}

/** Human-readable, deterministic evidence label — never an opaque score (§16). */
export const EVIDENCE_LABEL_AR: Record<MatchEvidenceKind, string> = {
  ecl_active: "هوية ECL نشطة",
  external_id: "معرّف خارجي مطابق تمامًا",
  sku: "SKU مطابق تمامًا",
  barcode: "باركود صالح مطابق تمامًا",
  variant_sku: "SKU خيار مطابق تمامًا",
  none: "لا يوجد دليل حتمي",
};
