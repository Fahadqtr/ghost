// Canonical definition of the Malikas operational master — PURE constants.
//
// The operational product universe is every product holding an ACTIVE
// `snoonu:malikas` row in `external_channel_listings`. Both the catalog reader
// (/v2/catalog) and the Home Dashboard membership provider import these, so the
// two surfaces can never drift onto different definitions.
//
// The master's SIZE is never defined here — it is derived from the data on
// every request.

/** The storefront whose ACTIVE listings define catalog membership. */
export const CATALOG_STOREFRONT_KEY = "snoonu:malikas";
/** Only listings in this mapping state count as membership. */
export const CATALOG_MAPPING_STATUS = "active";

// ── Internal catalog scope (CAT-B) ───────────────────────────────────────────
//
// /v2/catalog is the INTERNAL master catalog, not a mirror of what is live on
// Snoonu. Membership of the Snoonu master is channel EVIDENCE, rendered as a
// badge — it is no longer what decides whether a product is listed at all.
//
// Visibility is therefore decided from internal product truth only. Two kinds of
// row are deliberately withheld, and neither is a judgement about Snoonu:
//
//   • PENDING-* rows are SYSTEM INTAKE placeholders minted by Snoonu discovery.
//     Their "SKU" is a Snoonu-side hex id, they carry no barcode, and the same
//     physical product can appear more than once. They are not catalogue
//     products and must not be counted as such.
//   • STOPPED rows are products the owner deliberately stopped.
//
// Verified against production before this rule was written: of the 1343 products
// visible under the old Snoonu-membership scope, ZERO are PENDING-* and ZERO are
// STOPPED — so adding these exclusions cannot hide anything that is visible
// today. The rule only ever adds rows.

/** Prefix of the system intake placeholders minted by Snoonu discovery. */
export const PENDING_SKU_PREFIX = "PENDING-";

/** Lifecycle states withheld from the internal catalog. */
export const EXCLUDED_LIFECYCLE_STATES: readonly string[] = ["STOPPED"];

/** Snoonu publication state of one product — channel evidence, never identity. */
export type SnoonuChannelState = "SNOONU_ACTIVE" | "SNOONU_INACTIVE" | "NOT_PUBLISHED_TO_SNOONU";

/** Fixed Arabic labels. Never derived from, and never revealing, an external id. */
export const SNOONU_CHANNEL_LABEL: Readonly<Record<SnoonuChannelState, string>> = {
  SNOONU_ACTIVE: "منشور على سنونو",
  SNOONU_INACTIVE: "متوقف على سنونو",
  NOT_PUBLISHED_TO_SNOONU: "غير منشور على سنونو",
};

/**
 * Does this product belong in the internal catalog? Decided from internal truth
 * only — this function never sees a channel, a listing or an external id.
 * Anything malformed is withheld rather than admitted.
 */
export function isInternalCatalogProduct(sku: unknown, lifecycleState: unknown): boolean {
  if (typeof sku !== "string") return false;
  const trimmed = sku.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.toUpperCase().startsWith(PENDING_SKU_PREFIX)) return false;
  if (typeof lifecycleState === "string" && EXCLUDED_LIFECYCLE_STATES.includes(lifecycleState.trim().toUpperCase())) {
    return false;
  }
  return true;
}

/**
 * Classify a product's Snoonu publication state from listing evidence alone.
 * "Has a listing that is not active" is distinguished from "never published" —
 * the two are different operational facts and must not be collapsed.
 */
export function snoonuChannelState(hasActiveListing: boolean, hasAnyListing: boolean): SnoonuChannelState {
  if (hasActiveListing) return "SNOONU_ACTIVE";
  if (hasAnyListing) return "SNOONU_INACTIVE";
  return "NOT_PUBLISHED_TO_SNOONU";
}
