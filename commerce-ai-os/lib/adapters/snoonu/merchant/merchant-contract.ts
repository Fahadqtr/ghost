// CH.6B — Snoonu Merchant connector contracts (PURE).
//
// Contracts for the Merchant image-recovery pipeline: the session PORT, listing
// provenance, match status, preview rows, and apply results. The concrete portal
// interaction (API/network preferred; DOM fallback) is an injected implementation
// of SnoonuMerchantSession — this module holds NO automation, NO credentials, NO
// DB. Storefront is ALWAYS explicit (snoonu:malikas | snoonu:pure_seoul).
//
// PURE: no imports. node:test loads it directly.

export type SnoonuStorefrontKey = "snoonu:malikas" | "snoonu:pure_seoul";

export const SNOONU_STOREFRONT_KEYS: readonly SnoonuStorefrontKey[] = ["snoonu:malikas", "snoonu:pure_seoul"];

/** Merchant session lifecycle. OTP/MFA is surfaced, never bypassed. */
export type MerchantSessionState = "authenticated" | "session_required" | "otp_required" | "error";

/** One listing as seen on the merchant portal (identity + media source). */
export interface MerchantListing {
  storefrontKey: SnoonuStorefrontKey;
  spi: string;
  sku: string | null;
  barcode: string | null;
  title: string | null;
  /** Original source image URL (signed/CDN). Downloaded server-side — never persisted as-is. */
  imageUrl: string | null;
}

export interface ListingLookupResult {
  state: MerchantSessionState;
  listing: MerchantListing | null;
  /** Safe public error (detail is logged server-side, never returned). */
  error?: string;
}

/**
 * The injected merchant session PORT. Implementations authenticate operator-side
 * (interactive login / reused session / OTP pause) and look up listings by the
 * storefront's own SPI. Never accepts a password in-band; never returns cookies.
 */
export interface SnoonuMerchantSession {
  readonly storefrontKey: SnoonuStorefrontKey;
  state(): Promise<MerchantSessionState>;
  /** Locate a listing by the storefront-scoped SPI (identity lookup). */
  findListingBySpi(spi: string): Promise<ListingLookupResult>;
}

/** Deterministic match outcome for an image-import candidate. */
export type ImageMatchStatus = "MATCHED" | "NEEDS_REVIEW" | "NOT_FOUND" | "SESSION_REQUIRED";

/** Full provenance for a candidate — shown before any apply. */
export interface MatchProvenance {
  storefrontKey: SnoonuStorefrontKey;
  spi: string | null;
  merchantSku: string | null;
  merchantBarcode: string | null;
  merchantTitle: string | null;
  internalProductId: string;
  confidence: "high" | "medium" | "none";
}

export interface ImageCandidateProduct {
  id: string;
  sku: string | null;
  barcode: string | null;
  hasPrimaryImage: boolean;
}

export interface ImagePreviewRow {
  productId: string;
  sku: string | null;
  barcode: string | null;
  storefrontKey: SnoonuStorefrontKey;
  spi: string | null;
  currentImage: boolean; //        product already has a valid primary image
  merchantImageUrl: string | null; // preview source (never persisted directly)
  matchStatus: ImageMatchStatus;
  reason: string;
  provenance: MatchProvenance;
  /** true only for MATCHED rows — the sole rows an apply may act on. */
  selectable: boolean;
}

export interface ImagePreviewSummary {
  missing: number;
  matched: number;
  needsReview: number;
  notFound: number;
  sessionRequired: number;
}

export type ApplyItemStatus = "IMPORTED" | "SKIPPED" | "NEEDS_REVIEW" | "FAILED";

export interface ApplyItemResult {
  productId: string;
  status: ApplyItemStatus;
  reason?: string;
  url?: string; //  our permanent stored URL on IMPORTED
}
