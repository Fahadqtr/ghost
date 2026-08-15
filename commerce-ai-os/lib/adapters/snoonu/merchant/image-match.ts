// CH.6B — deterministic listing↔product match (PURE).
//
// Match order (§4): ECL Snoonu SPI for the selected storefront → exact SKU →
// exact barcode. Name matching is diagnostics/manual-review ONLY and NEVER
// auto-accepts an image write. Storefront is explicit; a storefront's SPI is
// never cross-used.
//
// PURE: imports only the contract types. node:test loads it directly.

import {
  type ImageMatchStatus,
  type MatchProvenance,
  type MerchantListing,
  type MerchantSessionState,
  type SnoonuStorefrontKey,
} from "./merchant-contract.ts";

export interface ImageMatchInput {
  storefrontKey: SnoonuStorefrontKey;
  product: { id: string; sku: string | null; barcode: string | null };
  /** SPI resolved from the CH.5 ECL for THIS storefront (null = not mapped here). */
  spi: string | null;
  sessionState: MerchantSessionState;
  /** Listing the merchant session returned for the SPI (null = not found). */
  listing: MerchantListing | null;
}

export interface ImageMatchResult {
  status: ImageMatchStatus;
  reason: string;
  provenance: MatchProvenance;
  merchantImageUrl: string | null;
}

const eq = (a: string | null | undefined, b: string | null | undefined): boolean => {
  const x = (a ?? "").trim().toLowerCase();
  const y = (b ?? "").trim().toLowerCase();
  return x !== "" && x === y;
};

export function classifyImageMatch(input: ImageMatchInput): ImageMatchResult {
  const prov: MatchProvenance = {
    storefrontKey: input.storefrontKey,
    spi: input.spi,
    merchantSku: input.listing?.sku ?? null,
    merchantBarcode: input.listing?.barcode ?? null,
    merchantTitle: input.listing?.title ?? null,
    internalProductId: input.product.id,
    confidence: "none",
  };

  if (input.sessionState !== "authenticated") {
    return { status: "SESSION_REQUIRED", reason: "merchant session required", provenance: prov, merchantImageUrl: null };
  }
  // No ECL SPI for this storefront → cannot locate deterministically (name-only
  // is manual review, never an auto image write).
  if (!(input.spi ?? "").trim()) {
    return { status: "NOT_FOUND", reason: "no ECL SPI for this storefront", provenance: prov, merchantImageUrl: null };
  }
  if (!input.listing) {
    return { status: "NOT_FOUND", reason: "no merchant listing for SPI", provenance: prov, merchantImageUrl: null };
  }
  // SPI is the primary key; verify it matches what the session returned.
  if (!eq(input.listing.spi, input.spi)) {
    return { status: "NEEDS_REVIEW", reason: "merchant SPI does not match ECL SPI", provenance: prov, merchantImageUrl: null };
  }

  const skuOk = eq(input.listing.sku, input.product.sku);
  const barcodeOk = eq(input.listing.barcode, input.product.barcode);
  const imageUrl = (input.listing.imageUrl ?? "").trim() || null;

  // Deterministic MATCH requires SPI + at least one exact catalog-field verify.
  if (!skuOk && !barcodeOk) {
    return { status: "NEEDS_REVIEW", reason: "SPI matched but neither SKU nor barcode verifies", provenance: { ...prov, confidence: "medium" }, merchantImageUrl: imageUrl };
  }
  if (!imageUrl) {
    return { status: "NEEDS_REVIEW", reason: "matched listing has no source image", provenance: { ...prov, confidence: skuOk && barcodeOk ? "high" : "medium" }, merchantImageUrl: null };
  }
  return {
    status: "MATCHED",
    reason: skuOk && barcodeOk ? "SPI + SKU + barcode verified" : skuOk ? "SPI + SKU verified" : "SPI + barcode verified",
    provenance: { ...prov, confidence: skuOk && barcodeOk ? "high" : "medium" },
    merchantImageUrl: imageUrl,
  };
}
