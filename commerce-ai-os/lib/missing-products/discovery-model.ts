// CH.6F — Missing Products Discovery: shared PURE model (types + enums + small
// maps). No `@/` imports, no `server-only`, no DB — node:test loads it directly.
//
// Storefront keys are re-declared here (mirroring lib/channels/storefronts.ts)
// so the classifier stays pure; a guard test asserts the two lists never drift.

export type ChannelKey = "shopify" | "snoonu" | "talabat" | "rafeeq";
export type Grain = "product" | "variant";

/** The five external storefronts CH.6F scans. Mirror of STOREFRONT_KEYS. */
export const STOREFRONT_KEYS = [
  "shopify:malikas",
  "snoonu:malikas",
  "snoonu:pure_seoul",
  "talabat:malikas",
  "rafeeq:malikas",
] as const;
export type StorefrontKey = (typeof STOREFRONT_KEYS)[number];

/** Listing grain per storefront — Talabat is variant-grain (§8). */
export const STOREFRONT_GRAIN: Record<StorefrontKey, Grain> = {
  "shopify:malikas": "product",
  "snoonu:malikas": "product",
  "snoonu:pure_seoul": "product",
  "talabat:malikas": "variant",
  "rafeeq:malikas": "product",
};

/** Identity type expected per storefront (mirror of the ECL CHECK set). */
export const STOREFRONT_IDENTITY: Record<StorefrontKey, string> = {
  "shopify:malikas": "shopify_gid",
  "snoonu:malikas": "snoonu_spi",
  "snoonu:pure_seoul": "snoonu_spi",
  "talabat:malikas": "talabat_sku",
  "rafeeq:malikas": "rafeeq_product_id",
};

export function isStorefrontKey(v: unknown): v is StorefrontKey {
  return typeof v === "string" && (STOREFRONT_KEYS as readonly string[]).includes(v);
}

export function channelOf(sf: StorefrontKey): ChannelKey {
  return sf.slice(0, sf.indexOf(":")) as ChannelKey;
}

export function grainOf(sf: StorefrontKey): Grain {
  return STOREFRONT_GRAIN[sf];
}

// ── Classification (§5) ──────────────────────────────────────────────────────
export type GapStatus =
  | "MAPPED_OK"
  | "INTERNAL_ONLY"
  | "EXTERNAL_ONLY"
  | "MISSING_ECL"
  | "IDENTITY_CONFLICT"
  | "SKU_CONFLICT"
  | "BARCODE_CONFLICT"
  | "VARIANT_CONFLICT"
  | "NEEDS_REVIEW"
  | "NOT_SUPPORTED"
  | "ARCHIVED_INTERNAL";

export const GAP_STATUSES: readonly GapStatus[] = [
  "MAPPED_OK",
  "INTERNAL_ONLY",
  "EXTERNAL_ONLY",
  "MISSING_ECL",
  "IDENTITY_CONFLICT",
  "SKU_CONFLICT",
  "BARCODE_CONFLICT",
  "VARIANT_CONFLICT",
  "NEEDS_REVIEW",
  "NOT_SUPPORTED",
  "ARCHIVED_INTERNAL",
];

/** A status is a "conflict / review" problem that must NEVER be auto-repaired. */
export const CONFLICT_STATUSES: readonly GapStatus[] = [
  "IDENTITY_CONFLICT",
  "SKU_CONFLICT",
  "BARCODE_CONFLICT",
  "VARIANT_CONFLICT",
  "NEEDS_REVIEW",
];

export function isConflict(status: GapStatus): boolean {
  return (CONFLICT_STATUSES as readonly string[]).includes(status);
}

// ── Deterministic match evidence (§4/§16). No fuzzy kinds exist here. ─────────
export type MatchEvidenceKind =
  | "ecl_active" //   1. existing active ECL identity
  | "external_id" //  2. exact internal/external stable id
  | "sku" //          3. exact SKU
  | "barcode" //      4. exact valid barcode
  | "variant_sku" //  5. exact variant SKU
  | "none";

export type Confidence = "DETERMINISTIC" | "NONE";

/** Priority (lower = stronger). Drives the "matched by" hierarchy. */
export const EVIDENCE_RANK: Record<MatchEvidenceKind, number> = {
  ecl_active: 1,
  external_id: 2,
  sku: 3,
  barcode: 4,
  variant_sku: 5,
  none: 99,
};

// ── Repair action (§17) — only actions matching the classification. ──────────
export type RepairAction =
  | "NONE" //            MAPPED_OK
  | "CREATE_ECL" //      MISSING_ECL (deterministic)
  | "IMPORT_PRODUCT" //  EXTERNAL_ONLY + IMPORT_ELIGIBLE
  | "PREPARE_PUBLISH" // INTERNAL_ONLY (preview only; publish is out of CH.6F)
  | "REVIEW"; //         conflicts / needs_review / insufficient data

export type ImportEligibility = "IMPORT_ELIGIBLE" | "NEEDS_REVIEW" | "INSUFFICIENT_DATA";
export type PublishReadiness = "READY_TO_PUBLISH" | "BLOCKED";

/**
 * Actions offered for a status. Conflicts get REVIEW only — there is deliberately
 * NO generic "Fix All" for conflicts (§17). MAPPED_OK offers nothing.
 */
export function allowedActionsFor(status: GapStatus): readonly RepairAction[] {
  switch (status) {
    case "MAPPED_OK":
      return ["NONE"];
    case "MISSING_ECL":
      return ["CREATE_ECL"];
    case "EXTERNAL_ONLY":
      return ["IMPORT_PRODUCT", "REVIEW"];
    case "INTERNAL_ONLY":
      return ["PREPARE_PUBLISH"];
    case "IDENTITY_CONFLICT":
    case "SKU_CONFLICT":
    case "BARCODE_CONFLICT":
    case "VARIANT_CONFLICT":
    case "NEEDS_REVIEW":
      return ["REVIEW"];
    case "ARCHIVED_INTERNAL":
    case "NOT_SUPPORTED":
    default:
      return ["REVIEW"];
  }
}

/** A CREATE_ECL action is only ever offered for a deterministic MISSING_ECL. */
export function isDeterministicRepair(status: GapStatus, confidence: Confidence): boolean {
  return status === "MISSING_ECL" && confidence === "DETERMINISTIC";
}

// ── Per-item results for apply batches (§18) ─────────────────────────────────
export type ApplyOutcome =
  | "CREATED" //       new product imported
  | "MAPPED" //        new ECL row created
  | "UNCHANGED" //     already satisfied at apply time
  | "SKIPPED" //       not eligible / not selected-applicable
  | "STALE" //         world changed since preview
  | "FAILED" //        write error (safe message)
  | "NEEDS_REVIEW"; // deterministic guarantee lost → hand to human

// ── Arabic labels for the UI (kept with the model so it is the single source) ─
export const STATUS_LABEL_AR: Record<GapStatus, string> = {
  MAPPED_OK: "مرتبط",
  INTERNAL_ONLY: "داخلي فقط",
  EXTERNAL_ONLY: "خارجي فقط",
  MISSING_ECL: "هوية ECL ناقصة",
  IDENTITY_CONFLICT: "تعارض هوية",
  SKU_CONFLICT: "تعارض SKU",
  BARCODE_CONFLICT: "تعارض باركود",
  VARIANT_CONFLICT: "تعارض خيار",
  NEEDS_REVIEW: "بحاجة لمراجعة",
  NOT_SUPPORTED: "غير مدعوم",
  ARCHIVED_INTERNAL: "مؤرشف داخليًا",
};
