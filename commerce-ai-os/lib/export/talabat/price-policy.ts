// STEP 72 — the SINGLE Talabat selling-price resolver (PURE).
//
// One policy, one implementation, shared by every certified Talabat path: the
// preview, the package workbook, the pure exporter and the mapping snapshot.
// Before this existed the workbook resolved `discount ?? price` while the
// mapping sync resolved `channel ?? discount ?? price` — the same product could
// ship one price and record another (STEP 70 measured 69 such rows).
//
// THE POLICY (owner decision, STEP 72)
//   simple  : channelPrice ?? productPrice
//   variant : variantPrice(>0) ?? channelPrice ?? productPrice
//
// `products.discount_price` is EXCLUDED from selling-price precedence and is
// not an input here. STEP 70 established why: no live channel uses it (0/24 on
// Snoonu, Shopify, Rafeeq and Talabat alike), `malak_audit` holds zero events
// that ever set it, and honouring it would have shipped 15 rows at an average
// 68% below the price every other channel charges today. The canonical column
// is NOT modified — it simply stops steering Talabat.
//
// `channelPrice` is the product-grain price already carried by
// `channel_products.channel_price` for the exact Talabat channel — the same
// source the pure exporter and the mapping sync already read.
//
// A variant's own price OUTRANKS the product-grain channel price, so genuine
// option pricing survives: mk1597 (1 piece 15 / 3 pieces 48), mk995 (silver and
// gold 178 vs 158), mk1122, mk1161, and mk1121 — whose Snoonu channel price is
// 0 while its owner-confirmed options are 68 and 69.

/** A price is usable only when it is a finite number strictly greater than zero. */
export function positivePrice(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
}

export interface TalabatPriceInput {
  /** canonical `products.price` — the last-resort fallback. */
  productPrice: number | string | null | undefined;
  /** `channel_products.channel_price` for the EXACT Talabat channel, else null. */
  channelPrice: number | string | null | undefined;
  /**
   * `product_variants.price` for a variant row; omit (or null/<=0) for a simple
   * product row, and for a variant that carries no price of its own.
   */
  variantPrice?: number | string | null | undefined;
}

/** Which source supplied the resolved price — diagnostics only. */
export type TalabatPriceSource = "variant" | "channel" | "product" | "none";

export interface TalabatPriceResolution {
  /** the selling price to emit; null ⇒ no usable price (caller warns). */
  price: number | null;
  source: TalabatPriceSource;
}

/**
 * Resolve the Talabat selling price for one sellable row.
 *
 * `discount_price` is deliberately absent from the signature: it cannot lower
 * (or raise) a Talabat price even by accident, because it cannot be passed in.
 */
export function resolveTalabatSellingPrice(input: TalabatPriceInput): TalabatPriceResolution {
  const variant = positivePrice(input.variantPrice);
  if (variant !== null) return { price: variant, source: "variant" };
  const channel = positivePrice(input.channelPrice);
  if (channel !== null) return { price: channel, source: "channel" };
  const product = positivePrice(input.productPrice);
  if (product !== null) return { price: product, source: "product" };
  return { price: null, source: "none" };
}

/** The resolved price alone — `null` when no source yields a usable value. */
export function talabatSellingPrice(input: TalabatPriceInput): number | null {
  return resolveTalabatSellingPrice(input).price;
}
