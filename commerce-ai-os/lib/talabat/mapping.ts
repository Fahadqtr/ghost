// Pure helpers for the Talabat (and any no-variant-support channel) variant
// mapping. NO Supabase, NO network, NO I/O — just normalization + identity +
// validation + status classification, so it is fully unit-testable.
//
// Design rules baked in here:
//   * Malika is the source of truth; a mapping only RECORDS how a master
//     product/variant is represented on a channel.
//   * The DURABLE key is the variant SKU, never product_variants.id (variant
//     rows are wiped and re-created on every product edit) and never the title.
//   * A no-variant product maps with masterVariantSku = null.
//   * An empty channelProductId is NOT a confirmed mapping (it stays null until
//     Talabat returns the external id).
//   * Barcodes are cleaned, never invented/generated here.

export type MappingStatus = "active" | "needs_review" | "archived";

/**
 * A candidate mapping, assembled from master catalogue data before it is
 * persisted. Note there is intentionally NO variant id field — the durable
 * identity is (channelId, masterProductId, masterVariantSku).
 */
export interface MappingCandidate {
  channelId: string;
  masterProductId: string;
  /** null = the master product has no variants; a string = that variant's SKU. */
  masterVariantSku: string | null;
  exportedSku: string;
  exportedBarcode?: string | null;
  channelProductId?: string | null;
  /** true when the master product/variant is archived or deactivated. */
  archived?: boolean;
}

/** The durable identity of a mapping. Deliberately contains no variant id. */
export interface MappingIdentity {
  channelId: string;
  masterProductId: string;
  masterVariantSku: string | null;
}

export interface MappingValidation {
  ok: boolean;
  errors: string[];
  /** A confirmed mapping is one Talabat has assigned an external id to. */
  confirmed: boolean;
}

/** Trim; return null when empty. Never fabricates a value. */
export function normalizeChannelProductId(value: string | null | undefined): string | null {
  const v = String(value ?? "").trim();
  return v === "" ? null : v;
}

/** Trim to the canonical exported SKU. May return "" (caller validates non-empty). */
export function normalizeExportedSku(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

/**
 * Clean a barcode without inventing one: trim and drop internal whitespace
 * (barcodes never contain spaces). Returns null when empty. Does NOT validate a
 * check digit, pad, or generate — a missing barcode stays missing.
 */
export function normalizeBarcode(value: string | null | undefined): string | null {
  const v = String(value ?? "").replace(/\s+/g, "").trim();
  return v === "" ? null : v;
}

/** Normalize a master variant SKU: null stays null; a blank string becomes null. */
export function normalizeMasterVariantSku(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const v = String(value).trim();
  return v === "" ? null : v;
}

/**
 * The durable identity of a mapping: channel + master product + variant SKU.
 * No variant id and no title are ever part of the identity.
 */
export function buildMappingIdentity(candidate: MappingCandidate): MappingIdentity {
  return {
    channelId: String(candidate.channelId ?? "").trim(),
    masterProductId: String(candidate.masterProductId ?? "").trim(),
    masterVariantSku: normalizeMasterVariantSku(candidate.masterVariantSku),
  };
}

/** True only when Talabat has returned a non-empty external id for the mapping. */
export function isMappingConfirmed(candidate: MappingCandidate): boolean {
  return normalizeChannelProductId(candidate.channelProductId) !== null;
}

/**
 * Validate a candidate. Requires channel + master product + a non-empty
 * exported SKU. A variant mapping (masterVariantSku provided) must have a
 * non-empty variant SKU; a no-variant product passes with masterVariantSku
 * null. channelProductId is optional (null until Talabat assigns it).
 */
export function validateMappingCandidate(candidate: MappingCandidate): MappingValidation {
  const errors: string[] = [];

  if (String(candidate.channelId ?? "").trim() === "") errors.push("channelId is required");
  if (String(candidate.masterProductId ?? "").trim() === "") errors.push("masterProductId is required");
  if (normalizeExportedSku(candidate.exportedSku) === "") errors.push("exportedSku must be non-empty");

  // A variant product signals its variant via a non-null masterVariantSku; if
  // it is present it must not be blank. null is valid (no-variant product).
  if (candidate.masterVariantSku !== null && candidate.masterVariantSku !== undefined) {
    if (String(candidate.masterVariantSku).trim() === "") errors.push("masterVariantSku must be non-empty for a variant mapping");
  }

  return { ok: errors.length === 0, errors, confirmed: isMappingConfirmed(candidate) };
}

/**
 * Classify a mapping's status:
 *   * archived      — the master product/variant is archived/deactivated.
 *   * needs_review  — invalid identity, or missing the barcode a Talabat
 *                     product requires (avoids shipping a duplicate/blank barcode).
 *   * active        — a complete, valid mapping (channelProductId may still be
 *                     null; that only affects `confirmed`, not the status).
 */
export function classifyMappingStatus(candidate: MappingCandidate): MappingStatus {
  if (candidate.archived === true) return "archived";
  const v = validateMappingCandidate(candidate);
  if (!v.ok) return "needs_review";
  if (normalizeBarcode(candidate.exportedBarcode) === null) return "needs_review";
  return "active";
}
