// CH.5 — Storefront registry (PURE).
//
// A Storefront is a FIRST-CLASS concept, distinct from a Channel. One channel may
// have several storefronts, and the same internal product can carry a DIFFERENT
// external identity in each. The real topology this encodes:
//
//   Malikas    → Shopify, Snoonu, Talabat, Rafeeq
//   Pure Seoul → Snoonu   (a second, independent Snoonu storefront)
//
// Canonical, stable storefront keys are "<channel>:<businessUnit>" and are unique
// across the whole system. Inventory/internal products stay shared & authoritative
// (this module owns identity only — never quantity).
//
// PURE: the only import is the pure CH.2 channel-model (keys). No @/ imports, no
// server-only, no DB/React/next — node:test loads it directly.

import { type ChannelKey } from "./channel-model.ts";

export type { ChannelKey };

/** Business unit (brand) a storefront belongs to. Inventory is shared across all. */
export type BusinessUnit = "malikas" | "pure_seoul";

/** How a storefront lists our catalog. Talabat flattens variants to listings. */
export type ListingGrain = "product" | "variant";

/**
 * The primary external-identity type a storefront uses. Storage is normalized
 * (all live in external_channel_listings); MEANING is preserved per channel.
 */
export type IdentityType =
  | "shopify_gid" //       Shopify product/variant GID
  | "snoonu_spi" //        Snoonu SPI (UniqueIdentifier), scoped PER storefront
  | "rafeeq_product_id" // Rafeeq platform product id
  | "talabat_sku"; //      Talabat SKU/barcode-based flattened-variant identity

export interface Storefront {
  /** Canonical, globally-unique key: "<channel>:<businessUnit>". */
  key: string;
  channel: ChannelKey;
  businessUnit: BusinessUnit;
  label: string;
  listingGrain: ListingGrain;
  identityType: IdentityType;
}

// The durable storefront registry. Adding a real storefront = one entry here.
export const STOREFRONTS: readonly Storefront[] = [
  { key: "shopify:malikas",     channel: "shopify",    businessUnit: "malikas",    label: "Shopify — Malika's Universe",  listingGrain: "product", identityType: "shopify_gid" },
  { key: "snoonu:malikas",      channel: "snoonu",     businessUnit: "malikas",    label: "Snoonu — Malika's Universe",   listingGrain: "product", identityType: "snoonu_spi" },
  // Pure Seoul is a SECOND Snoonu storefront (same channel, independent SPIs),
  // NOT a separate channel — that is the core CH.5 correction to the CH.2 model.
  { key: "snoonu:pure_seoul",   channel: "snoonu",     businessUnit: "pure_seoul", label: "Snoonu — Pure Seoul",          listingGrain: "product", identityType: "snoonu_spi" },
  { key: "talabat:malikas",     channel: "talabat",    businessUnit: "malikas",    label: "Talabat — Malika's Universe",  listingGrain: "variant",  identityType: "talabat_sku" },
  { key: "rafeeq:malikas",      channel: "rafeeq",     businessUnit: "malikas",    label: "Rafeeq — Malika's Universe",   listingGrain: "product", identityType: "rafeeq_product_id" },
] as const;

const BY_KEY: ReadonlyMap<string, Storefront> = new Map(STOREFRONTS.map((s) => [s.key, s]));

export function storefrontByKey(key: string): Storefront | null {
  return BY_KEY.get(key) ?? null;
}

/** Storefronts for a channel (>= 1; a channel can own several — e.g. Snoonu). */
export function storefrontsForChannel(channel: ChannelKey): Storefront[] {
  return STOREFRONTS.filter((s) => s.channel === channel);
}

export function storefrontsForUnit(unit: BusinessUnit): Storefront[] {
  return STOREFRONTS.filter((s) => s.businessUnit === unit);
}

/** Parse a canonical storefront key into its parts (null when unknown). */
export function parseStorefrontKey(key: string): Storefront | null {
  return storefrontByKey(key);
}

export const STOREFRONT_KEYS: readonly string[] = STOREFRONTS.map((s) => s.key);
