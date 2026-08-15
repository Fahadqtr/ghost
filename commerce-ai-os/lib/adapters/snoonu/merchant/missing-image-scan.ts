// CH.6B — missing-image candidate scan (PURE). Read-only classification; no writes.
//
// A candidate is a catalog product with no valid primary image. For each, produce
// a preview row using the deterministic matcher. Storefront is explicit; a Pure
// Seoul listing never satisfies a Malikas candidate (and vice versa).
//
// PURE: imports only sibling contracts + matcher. node:test loads it directly.

import {
  type ImageCandidateProduct,
  type ImagePreviewRow,
  type ImagePreviewSummary,
  type MerchantListing,
  type MerchantSessionState,
  type SnoonuStorefrontKey,
} from "./merchant-contract.ts";
import { classifyImageMatch } from "./image-match.ts";

export interface MissingImageScanInput {
  storefrontKey: SnoonuStorefrontKey;
  products: ImageCandidateProduct[];
  /** productId → ECL SPI for this storefront (null when unmapped here). */
  spiByProduct: Map<string, string | null>;
  /** productId → merchant listing (null when not found / not looked up). */
  listingByProduct: Map<string, MerchantListing | null>;
  sessionState: MerchantSessionState;
}

export interface MissingImageScanResult {
  storefrontKey: SnoonuStorefrontKey;
  rows: ImagePreviewRow[];
  summary: ImagePreviewSummary;
}

export function scanMissingImages(input: MissingImageScanInput): MissingImageScanResult {
  // Candidate = no valid primary image.
  const candidates = input.products.filter((p) => !p.hasPrimaryImage);
  const rows: ImagePreviewRow[] = candidates.map((p) => {
    const spi = input.spiByProduct.get(p.id) ?? null;
    const listing = input.listingByProduct.get(p.id) ?? null;
    const m = classifyImageMatch({
      storefrontKey: input.storefrontKey,
      product: { id: p.id, sku: p.sku, barcode: p.barcode },
      spi,
      sessionState: input.sessionState,
      listing,
    });
    return {
      productId: p.id,
      sku: p.sku,
      barcode: p.barcode,
      storefrontKey: input.storefrontKey,
      spi,
      currentImage: false, // it's a candidate → no valid primary image
      merchantImageUrl: m.merchantImageUrl,
      matchStatus: m.status,
      reason: m.reason,
      provenance: m.provenance,
      selectable: m.status === "MATCHED",
    };
  });

  const summary: ImagePreviewSummary = {
    missing: rows.length,
    matched: rows.filter((r) => r.matchStatus === "MATCHED").length,
    needsReview: rows.filter((r) => r.matchStatus === "NEEDS_REVIEW").length,
    notFound: rows.filter((r) => r.matchStatus === "NOT_FOUND").length,
    sessionRequired: rows.filter((r) => r.matchStatus === "SESSION_REQUIRED").length,
  };
  return { storefrontKey: input.storefrontKey, rows, summary };
}
