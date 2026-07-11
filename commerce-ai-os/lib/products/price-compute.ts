// Effective product price — pure, DB-free.
//
// Rule (per Fahad): when a product HAS options (variants) with their own
// prices, the real price comes from the OPTIONS, not the parent product's
// price. A variant's effective price is its discount_price when set, else its
// price. The product then shows a range (min–max) drawn from its priced
// variants; only when no variant carries a price does it fall back to the
// parent's price. Kept pure so it can be reused on every page + unit-tested.

export interface PricedVariant {
  price?: number | string | null;
  discount_price?: number | string | null;
}

const one = (p: unknown, d: unknown): number | null => {
  const dd = Number(d);
  if (Number.isFinite(dd) && dd > 0) return dd;
  const pp = Number(p);
  return Number.isFinite(pp) && pp > 0 ? pp : null;
};

/** Effective (>0) price of each variant that has one. */
export function variantPrices(variants: PricedVariant[] | null | undefined): number[] {
  return (variants ?? [])
    .map((v) => one(v.price, v.discount_price))
    .filter((n): n is number => n != null);
}

export interface EffectivePrice {
  min: number | null;      // lowest usable price (or null when none)
  max: number | null;      // highest usable price
  fromVariants: boolean;   // true → the price(s) came from the options
  hasPrice: boolean;       // false → truly no usable price anywhere
}

/**
 * The price to SHOW/USE for a product. Priced variants win over the parent;
 * `min` is the single representative number (for sorting, ads, a channel push),
 * `min`–`max` is the display range.
 */
export function effectivePrice(
  price: number | string | null | undefined,
  discountPrice: number | string | null | undefined,
  variants?: PricedVariant[] | null,
): EffectivePrice {
  const vp = variantPrices(variants);
  if (vp.length) {
    return { min: Math.min(...vp), max: Math.max(...vp), fromVariants: true, hasPrice: true };
  }
  const base = one(price, discountPrice);
  return { min: base, max: base, fromVariants: false, hasPrice: base != null };
}

/** "78 ر.ق" or "78–95 ر.ق" using the passed formatter; "—" when no price. */
export function priceRangeLabel(ep: EffectivePrice, fmt: (n: number) => string): string {
  if (!ep.hasPrice || ep.min == null) return "—";
  if (ep.max != null && ep.max !== ep.min) return `${fmt(ep.min)} – ${fmt(ep.max)}`;
  return fmt(ep.min);
}
