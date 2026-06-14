// Price context for the Compliance Checker (price_consistency check).
//
// The checker compares a draft's price across platforms. Those per-channel
// prices come from channel_products joined to channels: the effective price for
// a channel is its channel_price, or the product's base price when channel_price
// is NULL (shared pricing). This module turns those rows into the
// platform_prices map the checker consumes — no checker logic change needed.

import type { Draft } from "./types";

export interface ChannelPriceRow {
  /** channels.name, e.g. 'Shopify' | 'Snoonu' | 'Talabat' | 'Rafeeq'. */
  channel: string;
  /** channel_products.channel_price (NULL = use the base price). */
  channel_price: number | null;
}

/** Build platform_prices = effective price per channel (channel_price ?? base). */
export function buildPlatformPrices(
  rows: ChannelPriceRow[],
  basePrice: number | null
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const eff = r.channel_price ?? basePrice;
    if (eff !== null && eff !== undefined) out[r.channel] = eff;
  }
  return out;
}

/** Attach channel-derived platform_prices to a draft before checking. */
export function withPlatformPrices(
  draft: Draft,
  rows: ChannelPriceRow[]
): Draft {
  return { ...draft, platform_prices: buildPlatformPrices(rows, draft.price ?? null) };
}
