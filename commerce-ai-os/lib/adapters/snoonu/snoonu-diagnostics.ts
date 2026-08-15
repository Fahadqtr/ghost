// CH.6A — Snoonu per-storefront diagnostics (PURE compute).
//
// Candidate reporting ONLY — counts, never mutations. Store-aware: Malikas and
// Pure Seoul are reported independently (a product mapped in one is UNMAPPED in
// the other). Availability is an explicit input (Availability Engine); this
// module never derives it from quantity and owns no stock.
//
// PURE: imports only CH.5 types. node:test loads it directly.

import { type MappingStatus } from "../../channels/external-listing-identity.ts";
import { type SnoonuAvailability } from "./snoonu-listing.ts";

export interface SnoonuDiagProduct {
  id: string;
  sku: string | null;
  barcode: string | null;
  hasImage: boolean;
}

/** One ECL row for a Snoonu storefront (identity only — no quantity). */
export interface SnoonuDiagEclRow {
  productId: string;
  storefrontKey: string;
  spi: string | null; //           external_product_id
  mappingStatus: MappingStatus;
}

export interface StorefrontDiagnostics {
  storefrontKey: string;
  totalProducts: number;
  mapped: number; //               active ECL row with an SPI
  unmapped: number; //             catalog products with no active SPI in this store
  needsReview: number; //          ECL rows flagged needs_review
  stale: number; //                product-grain Snoonu has no SKU-drift signal → 0
  orphaned: number; //             ECL SPI whose internal product is gone
  missingImageCandidates: number; //   mapped products lacking an image
  missingBarcodeCandidates: number; // mapped products lacking a barcode
  availabilityMismatchCandidates: number; // mapped products flagged out_of_stock (candidate proxy; CH.6C compares live)
}

export interface SnoonuDiagnosticsInput {
  products: SnoonuDiagProduct[];
  eclRows: SnoonuDiagEclRow[];
  /** productId → explicit availability (Availability Engine). Optional in CH.6A. */
  availability?: Map<string, SnoonuAvailability>;
  /** Which storefronts to report (defaults to both). */
  storefrontKeys?: string[];
}

const DEFAULT_STORES = ["snoonu:malikas", "snoonu:pure_seoul"];

export function computeSnoonuStorefrontDiagnostics(input: SnoonuDiagnosticsInput, storefrontKey: string): StorefrontDiagnostics {
  const productById = new Map(input.products.map((p) => [p.id, p]));
  const totalProducts = input.products.length;
  const rows = input.eclRows.filter((r) => r.storefrontKey === storefrontKey);

  const activeMapped = new Map<string, SnoonuDiagEclRow>();
  let needsReview = 0;
  let orphaned = 0;
  for (const r of rows) {
    if (r.mappingStatus === "needs_review") needsReview++;
    const hasSpi = (r.spi ?? "").trim() !== "";
    if (r.mappingStatus === "active" && hasSpi) {
      if (!productById.has(r.productId)) orphaned++;
      else activeMapped.set(r.productId, r);
    }
  }

  const mapped = activeMapped.size;
  const unmapped = Math.max(0, totalProducts - mapped);

  let missingImageCandidates = 0;
  let missingBarcodeCandidates = 0;
  let availabilityMismatchCandidates = 0;
  for (const pid of activeMapped.keys()) {
    const p = productById.get(pid)!;
    if (!p.hasImage) missingImageCandidates++;
    if (!(p.barcode ?? "").trim()) missingBarcodeCandidates++;
    if (input.availability?.get(pid) === "out_of_stock") availabilityMismatchCandidates++;
  }

  return {
    storefrontKey,
    totalProducts,
    mapped,
    unmapped,
    needsReview,
    stale: 0, // product-grain Snoonu carries no exported SKU → no drift signal
    orphaned,
    missingImageCandidates,
    missingBarcodeCandidates,
    availabilityMismatchCandidates,
  };
}

export function computeSnoonuDiagnostics(input: SnoonuDiagnosticsInput): StorefrontDiagnostics[] {
  return (input.storefrontKeys ?? DEFAULT_STORES).map((k) => computeSnoonuStorefrontDiagnostics(input, k));
}
