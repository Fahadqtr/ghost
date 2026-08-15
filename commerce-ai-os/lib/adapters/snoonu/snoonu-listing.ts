// CH.6A — Snoonu listing projection (PURE).
//
// A normalized, storefront-scoped view of one internal product as a Snoonu
// listing. Combines: the internal catalog fields (sku/barcode/name/price), the
// EXTERNAL SPI resolved from the CH.5 ECL for THIS storefront, and an EXPLICIT
// availability signal (from the Availability Engine — never derived from
// quantity). It owns NO quantity. Read-only projection; no writes.
//
// PURE: imports only the CH.5 identity types. node:test loads it directly.

import { type MappingHealth, type MappingStatus } from "../../channels/external-listing-identity.ts";

export type { MappingHealth };

/** Explicit availability — sourced from the Availability Engine, not from stock. */
export type SnoonuAvailability = "in_stock" | "out_of_stock" | "unknown";

export interface SnoonuListing {
  /** snoonu:malikas | snoonu:pure_seoul — always explicit. */
  storefrontKey: string;
  productId: string;
  sku: string | null;
  barcode: string | null;
  nameEn: string | null;
  nameAr: string | null;
  price: number | null;
  /** External Snoonu SPI for THIS storefront (from ECL); null when unmapped. */
  spi: string | null;
  identityType: "snoonu_spi";
  /** Explicit availability (Availability Engine). Never a quantity. */
  availability: SnoonuAvailability;
  /** Read-only listing/approval status overlay (informational). */
  status: string | null;
  health: MappingHealth;
}

export interface SnoonuProductInput {
  id: string;
  sku?: string | null;
  barcode?: string | null;
  name_en?: string | null;
  name_ar?: string | null;
  price?: number | string | null;
}

export interface ProjectSnoonuListingInput {
  /** REQUIRED — Malikas vs Pure Seoul is never inferred. */
  storefrontKey: string;
  product: SnoonuProductInput;
  /** SPI resolved from ECL for this storefront (null = unmapped in this store). */
  spi: string | null;
  /** ECL mapping lifecycle for this storefront's row (absent when unmapped). */
  mappingStatus?: MappingStatus | null;
  /** Explicit availability from the Availability Engine. */
  availability?: SnoonuAvailability;
  status?: string | null;
  /** Whether the internal product still exists (default true). */
  productExists?: boolean;
}

const numOrNull = (v: number | string | null | undefined): number | null => {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};
const strOrNull = (v: string | null | undefined): string | null => {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
};

/**
 * Single-listing health (storefront-scoped). STALE / AMBIGUOUS are cross-row
 * conditions surfaced by the diagnostics reader, not by a single projection.
 */
export function snoonuListingHealth(spi: string | null, mappingStatus: MappingStatus | null | undefined, productExists: boolean): MappingHealth {
  if (!productExists) return "ORPHANED";
  if (mappingStatus === "needs_review") return "NEEDS_REVIEW";
  if (!strOrNull(spi)) return "UNMAPPED";
  return "HEALTHY";
}

/** Project one internal product into a Snoonu listing for an explicit storefront. */
export function projectSnoonuListing(input: ProjectSnoonuListingInput): SnoonuListing {
  const spi = strOrNull(input.spi);
  const productExists = input.productExists !== false;
  return {
    storefrontKey: input.storefrontKey,
    productId: input.product.id,
    sku: strOrNull(input.product.sku),
    barcode: strOrNull(input.product.barcode),
    nameEn: strOrNull(input.product.name_en),
    nameAr: strOrNull(input.product.name_ar),
    price: numOrNull(input.product.price),
    spi,
    identityType: "snoonu_spi",
    availability: input.availability ?? "unknown",
    status: strOrNull(input.status),
    health: snoonuListingHealth(spi, input.mappingStatus ?? null, productExists),
  };
}
