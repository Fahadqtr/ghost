// INT.2A — shared export preview model (PURE).
//
// The contract future destination adapters populate for their preview(). The
// GRAIN is first-class: Talabat previews at SELLABLE_LISTING grain (one row per
// sellable variant), product-grain destinations at PRODUCT grain. INT.2A defines
// the shape only — it produces no real preview rows.

import type { ExportItemStatus, ExportReason } from "./validation.ts";

/**
 * The unit a preview row represents:
 *   PRODUCT          — one row per internal product (Shopify/Snoonu/Rafeeq)
 *   VARIANT          — one row per variant (internal grain)
 *   SELLABLE_LISTING — one row per sellable variant listing (Talabat flattening)
 */
export type ExportGrain = "PRODUCT" | "VARIANT" | "SELLABLE_LISTING";

export const EXPORT_GRAINS: readonly ExportGrain[] = ["PRODUCT", "VARIANT", "SELLABLE_LISTING"];

/** External identity as represented through ECL (never legacy products.*_id). */
export interface ExportExternalIdentity {
  storefrontKey: string;
  externalProductId: string | null;
  externalVariantId: string | null;
  exportedSku: string | null;
  identityType: string | null;
}

export interface ExportPreviewItem {
  internalProductId: string;
  variantId: string | null;
  sku: string | null;
  barcode: string | null;
  title: string | null;
  destination: string;
  storefront: string;
  grain: ExportGrain;
  status: ExportItemStatus;
  warnings: readonly ExportReason[];
  blockingReasons: readonly ExportReason[];
  imageCount: number;
  primaryImage: string | null;
  externalIdentity: ExportExternalIdentity | null;
  metadata: Record<string, unknown>;
}

/** A preview result for one destination — rows plus the grain they were produced at. */
export interface ExportPreview {
  destination: string;
  grain: ExportGrain;
  items: readonly ExportPreviewItem[];
  /** true when the adapter cannot yet produce a real preview (INT.2A default). */
  placeholder: boolean;
}

/** An empty, placeholder preview for a destination (INT.2A foundation default). */
export function emptyPreview(destination: string, grain: ExportGrain): ExportPreview {
  return { destination, grain, items: [], placeholder: true };
}
