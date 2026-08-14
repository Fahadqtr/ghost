// Availability read-model (INV.2C). Availability is an EXPLICIT, product-level
// state stored in products.stock_status. It is NOT derived from any quantity —
// never from inventory.stock_quantity, product_variants.stock_quantity, their
// sum, or max(parent, variants). Quantity lives in a separate layer owned by the
// future Inventory Engine.
//
// Allowed operational states for this phase: "In Stock" | "Out of Stock".
// Legacy / unknown values ("Low Stock", "", null, anything else) are NEVER
// silently reinterpreted into an In/Out guess: normalizeAvailability returns
// null and isAvailable returns false (an unset/unknown availability is treated
// as not-available — conservative, and staff can set it operationally).
//
// PURE: no @/ imports, no DB client, no React, no next/*, no server-only.

export const AVAILABILITY_STATES = ["In Stock", "Out of Stock"] as const;
export type AvailabilityState = (typeof AVAILABILITY_STATES)[number];

/** Canonical availability state for an explicit boolean toggle. */
export function availabilityFromInStock(inStock: boolean): AvailabilityState {
  return inStock ? "In Stock" : "Out of Stock";
}

/**
 * Normalize a raw stock_status value to one of the two allowed availability
 * states, or `null` when it is neither. Never guesses — "Low Stock", "", null,
 * or any other value returns null (it is not coerced into In/Out).
 */
export function normalizeAvailability(raw: unknown): AvailabilityState | null {
  const t = typeof raw === "string" ? raw.trim() : "";
  if (t === "In Stock") return "In Stock";
  if (t === "Out of Stock") return "Out of Stock";
  return null;
}

/**
 * Is the product available? True ONLY for an explicit "In Stock". Every other
 * value — "Out of Stock", "Low Stock", null, unknown — is not available.
 * Availability is never derived from quantity.
 */
export function isAvailable(raw: unknown): boolean {
  return normalizeAvailability(raw) === "In Stock";
}

/** Localized label for a raw availability value. */
export function availabilityLabel(raw: unknown, locale: "ar" | "en" = "ar"): string {
  const s = normalizeAvailability(raw);
  if (s === "In Stock") return locale === "en" ? "In Stock" : "متوفر";
  if (s === "Out of Stock") return locale === "en" ? "Out of Stock" : "نافد";
  return locale === "en" ? "Unknown" : "غير محدد";
}
