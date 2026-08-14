// Scheduled availability sync — pure, DB-free core.
//
// INV.2D: availability is an EXPLICIT product state (products.stock_status),
// managed by staff via the Availability Engine (lib/availability). This module
// PROJECTS that authoritative state onto every overlay platform's
// `platform_status.availability`. It never derives availability from quantity
// (inventory / variant stock) and never treats platform_status.availability as a
// source of truth — the projection is deterministic and reproducible straight
// from products.stock_status.
//
// (Upload-driven, platform-specific signals — a platform selling out while the
// master still shows In Stock — remain the job of the manual reconcile, which
// surfaces them as conflicts.)
//
// No next/headers and no Supabase here, so it is unit-testable directly.

import { isAvailable } from "./availability/read.ts";

export type Availability = "InStock" | "OutOfStock";

/** One row of the master `products` table (subset) — the availability source. */
export interface ProductAvailabilityRow {
  id: string | null;
  stock_status: string | null;
}

/** Desired availability for a single product, from its explicit stock_status. */
export interface ProductStatus {
  product_id: string;
  availability: Availability;
}

/** An upsert destined for `platform_status` (product × platform overlay). */
export interface StatusUpsert {
  product_id: string;
  platform: string;
  availability: Availability;
  updated_at: string;
}

export interface SyncCounts {
  products: number;   // distinct products with an inventory signal
  out: number;        // reconciled OutOfStock
  inStock: number;    // reconciled InStock
}

/**
 * Project each product's EXPLICIT availability (products.stock_status) to the
 * overlay availability value: `In Stock` → InStock; everything else (Out of
 * Stock, unknown, null) → OutOfStock, via the shared read-model (isAvailable).
 * Never derived from quantity; deterministic and reproducible from stock_status.
 * Duplicate product ids collapse to the first row seen.
 */
export function projectAvailability(products: ProductAvailabilityRow[]): ProductStatus[] {
  const out: ProductStatus[] = [];
  const seen = new Set<string>();
  for (const p of products) {
    if (!p.id || seen.has(p.id)) continue;
    seen.add(p.id);
    out.push({ product_id: p.id, availability: isAvailable(p.stock_status) ? "InStock" : "OutOfStock" });
  }
  return out;
}

/** Key for the current-state lookup: one availability per (product, platform). */
export function statusKey(productId: string, platform: string): string {
  return `${productId}|${platform}`;
}

/**
 * Plan the minimal set of `platform_status` upserts to bring every overlay
 * platform in line with the master-derived status. Only rows whose current
 * availability differs from the desired one are emitted, so a run that changes
 * nothing writes nothing.
 *
 * @param current Map of statusKey(product, platform) → current availability
 *                ("InStock" | "OutOfStock"); a missing entry counts as unset and
 *                always produces an upsert.
 */
export function planStatusUpserts(
  statuses: ProductStatus[],
  overlayPlatforms: readonly string[],
  current: Map<string, string>,
  nowIso: string,
): { upserts: StatusUpsert[]; counts: SyncCounts } {
  const upserts: StatusUpsert[] = [];
  let out = 0;
  let inStock = 0;
  for (const s of statuses) {
    if (s.availability === "OutOfStock") out++;
    else inStock++;
    for (const platform of overlayPlatforms) {
      if (current.get(statusKey(s.product_id, platform)) === s.availability) continue;
      upserts.push({ product_id: s.product_id, platform, availability: s.availability, updated_at: nowIso });
    }
  }
  return { upserts, counts: { products: statuses.length, out, inStock } };
}
