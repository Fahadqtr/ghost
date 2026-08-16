// CH.6D — Snoonu barcode completion diff / classifier (PURE).
//
// Given a candidate internal row (product OR variant) that is resolved to Snoonu
// listings through the ECL identity layer, plus the deterministic barcode
// evidence per storefront, classify the completion outcome. This module NEVER
// invents a barcode, NEVER overwrites a non-empty internal barcode, and applies
// the multi-store agreement policy (§5) and internal-uniqueness policy (§6).
//
// PURE: imports only pure siblings + canonical validators (relative, no @/).
// node:test loads it directly.

import { type SnoonuStorefrontKey } from "../merchant/merchant-contract.ts";
import { normalizeBarcode, isSyntacticallyValidBarcode } from "./snoonu-barcode-normalize.ts";

export type TargetKind = "product" | "variant";

export type BarcodeStatus =
  | "AUTO_COMPLETABLE" //       exactly one valid, unique source barcode; internal empty
  | "UNCHANGED" //             internal already has this barcode (or nothing to do)
  | "CONFLICT" //              storefronts disagree, or source ≠ non-empty internal
  | "DUPLICATE_INTERNAL" //    the source barcode already belongs to another internal item
  | "INVALID_SOURCE_BARCODE" //source barcode is not a valid catalog barcode
  | "NEEDS_REVIEW" //          ambiguous identity (multiple listings resolve in one store)
  | "NOT_FOUND"; //            resolves to a listing, but no barcode present

/** One piece of deterministic barcode evidence from a single storefront listing. */
export interface BarcodeEvidence {
  storefront: SnoonuStorefrontKey;
  spi: string | null;
  /** Raw barcode as seen on that storefront's listing (may be null/blank). */
  rawBarcode: string | null;
}

/** A candidate internal row resolved to Snoonu evidence via ECL. */
export interface BarcodeCandidate {
  targetKind: TargetKind;
  productId: string;
  /** null for a simple product; the variant id for a variant target. */
  variantId: string | null;
  sku: string | null;
  name: string | null;
  /** Current internal barcode (products.barcode or product_variants.barcode). */
  currentBarcode: string | null;
  /** Evidence across the storefronts this target is mapped in. */
  evidence: BarcodeEvidence[];
}

export interface BarcodeDiffRow {
  targetKind: TargetKind;
  productId: string;
  variantId: string | null;
  sku: string | null;
  name: string | null;
  currentBarcode: string | null;
  /** The barcode we would write (null unless AUTO_COMPLETABLE). */
  incoming: string | null;
  /** Storefronts that supplied the winning evidence. */
  evidenceStorefronts: SnoonuStorefrontKey[];
  status: BarcodeStatus;
  reason: string;
  /** true only for AUTO_COMPLETABLE — the sole rows an apply may act on. */
  actionable: boolean;
}

/**
 * Classify one candidate. `isOwnedByOther(barcode)` returns true when the barcode
 * already belongs to a DIFFERENT internal sellable identity (products.barcode /
 * product_variants.barcode) — used for the internal-uniqueness check (§6). Pure.
 */
export function classifyBarcode(
  c: BarcodeCandidate,
  isOwnedByOther: (barcode: string) => boolean,
): BarcodeDiffRow {
  const base = {
    targetKind: c.targetKind, productId: c.productId, variantId: c.variantId,
    sku: c.sku, name: c.name, currentBarcode: c.currentBarcode,
  };
  const cur = normalizeBarcode(c.currentBarcode);

  // No mapping at all → cannot source deterministically.
  if (!c.evidence || c.evidence.length === 0) {
    return { ...base, incoming: null, evidenceStorefronts: [], status: "NEEDS_REVIEW", reason: "no active Snoonu mapping — map the listing first", actionable: false };
  }

  // Group PRESENT (non-blank) barcodes by storefront; preserve leading zeros.
  const perStore = new Map<SnoonuStorefrontKey, Set<string>>();
  for (const e of c.evidence) {
    const v = normalizeBarcode(e.rawBarcode);
    if (v === null) continue;
    const set = perStore.get(e.storefront) ?? new Set<string>();
    set.add(v);
    perStore.set(e.storefront, set);
  }

  // Within-store ambiguity: more than one distinct listing barcode in one store
  // → NOT "exactly one Snoonu listing" (§4). Never guess.
  for (const [store, values] of perStore) {
    if (values.size > 1) {
      return { ...base, incoming: null, evidenceStorefronts: [store], status: "NEEDS_REVIEW", reason: `multiple Snoonu listings resolve in ${store}`, actionable: false };
    }
  }

  const storeValues = [...perStore.entries()].map(([store, set]) => ({ store, value: [...set][0] }));

  // No barcode on any mapped listing.
  if (storeValues.length === 0) {
    return { ...base, incoming: null, evidenceStorefronts: [], status: cur ? "UNCHANGED" : "NOT_FOUND", reason: cur ? "already has a barcode; no Snoonu evidence to compare" : "mapped, but no barcode on any Snoonu listing", actionable: false };
  }

  const distinctAcross = [...new Set(storeValues.map((s) => s.value))];
  const stores = storeValues.map((s) => s.store);

  // Multi-store disagreement (§5): X vs Y → never silently pick one.
  if (distinctAcross.length > 1) {
    return { ...base, incoming: null, evidenceStorefronts: stores, status: "CONFLICT", reason: `Snoonu storefronts disagree: ${distinctAcross.join(" vs ")}`, actionable: false };
  }

  const value = distinctAcross[0];

  // Never overwrite a non-empty internal barcode automatically.
  if (cur !== null) {
    return { ...base, incoming: value, evidenceStorefronts: stores, status: cur === value ? "UNCHANGED" : "CONFLICT", reason: cur === value ? "internal barcode already matches Snoonu" : `internal ${cur} ≠ Snoonu ${value} (never overwritten automatically)`, actionable: false };
  }

  // Internal empty → completion candidate.
  if (!isSyntacticallyValidBarcode(value)) {
    return { ...base, incoming: value, evidenceStorefronts: stores, status: "INVALID_SOURCE_BARCODE", reason: `source barcode "${value}" is not a valid catalog barcode`, actionable: false };
  }
  if (isOwnedByOther(value)) {
    return { ...base, incoming: value, evidenceStorefronts: stores, status: "DUPLICATE_INTERNAL", reason: `barcode ${value} already belongs to another internal item`, actionable: false };
  }
  return {
    ...base, incoming: value, evidenceStorefronts: stores, status: "AUTO_COMPLETABLE",
    reason: stores.length > 1 ? `both storefronts agree (${value})` : `deterministic from ${stores[0]} (${value})`,
    actionable: true,
  };
}

export interface BarcodeDiffSummary {
  total: number;
  missingProduct: number;
  missingVariant: number;
  autoCompletable: number;
  unchanged: number;
  conflict: number;
  duplicateInternal: number;
  invalidSource: number;
  needsReview: number;
  notFound: number;
}

export function summarizeBarcode(rows: BarcodeDiffRow[]): BarcodeDiffSummary {
  const count = (s: BarcodeStatus) => rows.filter((r) => r.status === s).length;
  const missing = rows.filter((r) => normalizeBarcode(r.currentBarcode) === null);
  return {
    total: rows.length,
    missingProduct: missing.filter((r) => r.targetKind === "product").length,
    missingVariant: missing.filter((r) => r.targetKind === "variant").length,
    autoCompletable: count("AUTO_COMPLETABLE"),
    unchanged: count("UNCHANGED"),
    conflict: count("CONFLICT"),
    duplicateInternal: count("DUPLICATE_INTERNAL"),
    invalidSource: count("INVALID_SOURCE_BARCODE"),
    needsReview: count("NEEDS_REVIEW"),
    notFound: count("NOT_FOUND"),
  };
}
