// SHOPIFY.PRICE.1 — THE canonical pricing rule for every Shopify unit (PURE).
//
// Owner-approved policy (one rule, shared by preview, publish and the variant
// repair engine so the paths can never diverge again):
//
//   SELL PRICE  : variant.price ?? parent.discount_price ?? parent.price
//                 (positive values only — an explicit child price ALWAYS wins;
//                  the parent discount applies only when the child has none)
//   COMPARE-AT  : candidate = parent.price, and ONLY when a parent discount
//                 exists; sent/managed ONLY when candidate > sell price —
//                 otherwise null. A compare-at equal to or below the sell
//                 price is meaningless and is never planned or written.
//
// No I/O, no imports — node:test loads this directly.

/** Money compared to the cent — anything finer is noise. */
export const PRICE_EPSILON = 0.005;

const positive = (v: number | null | undefined): number | null =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;

export interface CanonicalUnitPricing {
  /** The one sell price for the unit (null only when no positive source exists). */
  sellPrice: number | null;
  /** Normalized compare-at: parent price when a real sale relationship exists, else null. */
  compareAtPrice: number | null;
}

/**
 * Normalize a compare-at candidate against the unit's sell price: keep it only
 * when it is strictly greater than the sell price (beyond money epsilon).
 */
export function normalizeCompareAt(sellPrice: number | null, candidate: number | null): number | null {
  const s = positive(sellPrice);
  const c = positive(candidate);
  if (s === null || c === null) return null;
  return c - s > PRICE_EPSILON ? c : null;
}

/** The canonical sell + compare-at pair for one Shopify unit. */
export function canonicalUnitPricing(
  variantPrice: number | null | undefined,
  parentDiscountPrice: number | null | undefined,
  parentPrice: number | null | undefined,
): CanonicalUnitPricing {
  const sellPrice = positive(variantPrice) ?? positive(parentDiscountPrice) ?? positive(parentPrice);
  const candidate = positive(parentDiscountPrice) !== null ? positive(parentPrice) : null;
  return { sellPrice, compareAtPrice: normalizeCompareAt(sellPrice, candidate) };
}
