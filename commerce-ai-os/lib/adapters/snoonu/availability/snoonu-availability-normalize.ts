// CH.6C — Snoonu availability normalization (PURE).
//
// Normalizes raw Snoonu availability (from the platform_status overlay / listing)
// into a tri-state, and maps it to the Availability Engine's explicit state.
// UNKNOWN is NEVER coerced into In/Out and never changes internal state.
//
// PURE: imports only the pure Availability read-model type. node:test loads it.

import { type AvailabilityState } from "../../../availability/read.ts";

export type SnoonuAvailability = "IN_STOCK" | "OUT_OF_STOCK" | "UNKNOWN";

/**
 * Normalize a raw availability token from Snoonu. Handles the overlay form
 * ("InStock"/"OutOfStock"), export form ("True"/"False"), and common variants.
 * Anything unrecognized → UNKNOWN (never guessed).
 */
export function normalizeSnoonuAvailability(raw: unknown): SnoonuAvailability {
  const t = (typeof raw === "string" ? raw : "").trim().toLowerCase().replace(/[\s_-]/g, "");
  if (t === "instock" || t === "available" || t === "true" || t === "in") return "IN_STOCK";
  if (t === "outofstock" || t === "unavailable" || t === "false" || t === "out" || t === "soldout") return "OUT_OF_STOCK";
  return "UNKNOWN";
}

/** Map the tri-state to the Availability Engine state, or null when UNKNOWN (never written). */
export function toEngineState(a: SnoonuAvailability): AvailabilityState | null {
  if (a === "IN_STOCK") return "In Stock";
  if (a === "OUT_OF_STOCK") return "Out of Stock";
  return null;
}
