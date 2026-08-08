// Malikas V2 — PureSoul presence mapper (Phase UI.9.1). PURE: no DB, no fetch,
// no clock, no secrets. Interprets the PureSoul overlay snapshot against
// Malikas (the Single Source of Truth) and reuses the EXISTING PlatformPresence
// contract from lib/operations — it invents no new type and re-implements no
// business logic; the operations platform-status engine turns presence into the
// final status.
//
// Mapping (overlay row = product KNOWN on PureSoul, so linked=true):
//   approval 'Rejected'      → reviewRequired  → status "review_required"
//   availability 'InStock'   → live=true       → status "published"
//   availability 'OutOfStock'→ live=false      → status "ready" (مخلّصة)
//   otherwise (row present)  → live=false       → status "ready"
// A product with NO overlay row is OMITTED by the caller → status "unknown".
// We never emit "missing" (no persisted confirmed-absent signal) and never emit
// "different" (no persisted PureSoul field to compare) in this phase.

import type { PlatformPresence } from "../../operations/shared/models";
import type { PureSoulOverlayRow } from "./types";

function norm(v: string | null | undefined): string {
  return String(v ?? "").trim().toLowerCase();
}

/** Build a TRUSTED PlatformPresence for ONE PureSoul-known product. `drift` is
 *  always false (no persisted PureSoul copy to compare), so "different" is never
 *  produced this phase. */
export function overlayRowToPresence(row: PureSoulOverlayRow): PlatformPresence {
  const availability = norm(row.availability);
  const rejected = norm(row.approval) === "rejected";
  return {
    linked: true, // a row exists ⇒ the product is known on PureSoul
    live: availability === "instock",
    drift: false,
    reviewRequired: rejected,
  };
}

/**
 * Build the productId → PlatformPresence map from the overlay rows. Only
 * products WITH a row are included (they are the trusted snapshot); everything
 * else is absent → the engine reports "unknown", never "missing". Blank/mixed
 * rows still count as "known on PureSoul" (linked) — availability/approval only
 * decide live/review.
 */
export function buildPureSoulPresence(
  rows: readonly PureSoulOverlayRow[],
): Map<string, PlatformPresence> {
  const map = new Map<string, PlatformPresence>();
  for (const row of rows) {
    const id = String(row.productId ?? "").trim();
    if (id === "") continue;
    map.set(id, overlayRowToPresence(row));
  }
  return map;
}
