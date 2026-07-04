// Ad-overlay text core — pure, DOM-free.
//
// Derives the exact strings that get painted onto the social image (brand,
// product name, price, CTA) from the product fields. Kept pure so the
// price/label rules are unit-tested; the actual canvas painting lives in
// ad-overlay-render.ts (browser-only) and can't be unit-tested here.

export interface AdOverlayInput {
  brand?: string | null;
  nameAr?: string | null;
  nameEn?: string | null;
  price?: number | string | null;
  discountPrice?: number | string | null;
}

export interface AdOverlayText {
  brand: string;   // "" when the product has no brand
  product: string; // Arabic name preferred, English fallback
  price: string;   // "" when there is no price, e.g. "86 ر.ق"
  cta: string;     // bilingual call-to-action (always present)
}

/** Qatari-riyal price label. Empty string for missing/invalid amounts. */
export function formatQar(v: number | string | null | undefined): string {
  if (v == null) return "";
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return "";
  // Trim a trailing ".0" but keep real decimals (e.g. 79.5).
  const num = Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
  return `${num} ر.ق`;
}

/**
 * Build the four ad strings. The discounted price wins over the list price
 * (matches the caption rule). Brand line is omitted when absent; the product
 * name falls back to English; the CTA is always shown.
 */
export function buildAdText(input: AdOverlayInput): AdOverlayText {
  const brand = String(input.brand ?? "").trim();
  const product = String(input.nameAr ?? "").trim() || String(input.nameEn ?? "").trim();
  const price = formatQar(input.discountPrice ?? null) || formatQar(input.price ?? null);
  return {
    brand,
    product,
    price,
    cta: "اطلبيه الآن • ORDER NOW",
  };
}
