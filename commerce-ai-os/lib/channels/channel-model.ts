// CH.2 — shared Channel model + mapping read-model (PURE, read-only).
//
// Makes the CH.0 Source-of-Truth Matrix executable: it unifies the FIVE
// fragmented channel-mapping regimes into ONE per-(product, channel) projection,
// each field tagged with its authoritative source. It reads nothing and writes
// nothing — a caller supplies already-read rows; this module only classifies.
//
// The five regimes it reconciles (all read-only inputs):
//   1. products.{snoonu_id, pure_seoul_id, rafeeq_product_id}  — denormalized external ids
//   2. channels + channel_products.{channel_status, channel_price} — publish/price overlay
//   3. platform_status (table).{approval, availability}         — approval/availability overlay
//   4. platform_snapshots                                       — external drift capture (not modeled here)
//   5. channel_variant_mappings.channel_product_id             — Talabat durable external id
//
// PURE: no @/ imports, no server-only, no DB/React/next — node:test loads it
// directly. The only import is the pure, dependency-free channel-policy sibling.

import { channelAvailabilityMode, type ChannelAvailabilityMode } from "../availability/channel-policy.ts";

// Canonical channel keys — aligned EXACTLY with CHANNEL_AVAILABILITY_MODE keys.
// (Note: the operations "platform matrix" uses "puresoul"; the DB/channel layer
// uses "pure_seoul". This model is the channel/DB layer, so it uses "pure_seoul".)
export const CHANNEL_KEYS = ["shopify", "talabat", "snoonu", "pure_seoul", "rafeeq"] as const;
export type ChannelKey = (typeof CHANNEL_KEYS)[number];

export const CHANNEL_LABELS: Record<ChannelKey, string> = {
  shopify: "Shopify",
  talabat: "Talabat",
  snoonu: "Snoonu",
  pure_seoul: "Pure Seoul",
  rafeeq: "Rafeeq",
};

/**
 * Map a free-text channels.name to a canonical ChannelKey (read-only projection
 * aid). Deterministic substring match; returns null when no key is recognized so
 * the caller can skip unknown channels rather than mis-attribute them.
 */
export function channelKeyFromName(name: string | null | undefined): ChannelKey | null {
  const n = (name ?? "").toLowerCase();
  if (n.includes("shopify")) return "shopify";
  if (n.includes("talabat")) return "talabat";
  if (n.includes("snoonu")) return "snoonu";
  if (n.includes("pure")) return "pure_seoul"; // "Pure Seoul" / "pure_seoul"
  if (n.includes("rafeeq")) return "rafeeq";
  return null;
}

/** Where a channel's durable external id lives (CH.0 mapping graph). */
export type ExternalIdSource =
  | "products_column"           // snoonu_id / pure_seoul_id / rafeeq_product_id
  | "channel_variant_mappings"  // Talabat channel_product_id
  | "live_match"                // Shopify — no persisted id; matched by SKU/title at runtime
  | "none";                     // no id known for this channel

export type ListingSource = "channel_products" | "none";
export type AvailabilitySource = "platform_status" | "none";
export type PriceSource = "channel_override" | "internal_base";

/** Minimal product shape this model needs (all read-only fields). */
export interface ChannelModelProduct {
  id: string;
  snoonu_id: string | null;
  pure_seoul_id: string | null;
  rafeeq_product_id: string | null;
}

/** channel_products overlay row for a (product, channel). */
export interface ChannelOverlayRow {
  channel_status: string | null;
  channel_price: number | null;
}

/** platform_status overlay row for a (product, platform). */
export interface PlatformStatusRow {
  approval: string | null;
  availability: string | null;
}

/** Inputs already read by the server reader, keyed by ChannelKey. */
export interface ProjectChannelsInput {
  product: ChannelModelProduct;
  /** channel_products overlay, per channel (absent = not listed row). */
  overlay?: Partial<Record<ChannelKey, ChannelOverlayRow>>;
  /** platform_status overlay, per channel (absent = no overlay row). */
  platformStatus?: Partial<Record<ChannelKey, PlatformStatusRow>>;
  /** Talabat durable external id from channel_variant_mappings (product-grain). */
  talabatChannelProductId?: string | null;
}

/** The unified per-(product, channel) projection — one row per channel. */
export interface ProductChannelProjection {
  productId: string;
  channel: ChannelKey;
  label: string;
  availabilityMode: ChannelAvailabilityMode;
  externalId: string | null;
  externalIdSource: ExternalIdSource;
  mappingPresent: boolean;
  listingStatus: string | null;
  listingSource: ListingSource;
  approval: string | null;
  availability: string | null;
  availabilitySource: AvailabilitySource;
  channelPrice: number | null;
  priceSource: PriceSource;
}

/**
 * Resolve a channel's durable external id + its source, per the CH.0 mapping graph.
 * Shopify has no persisted id (runtime SKU/title match) → "live_match".
 */
export function resolveChannelExternalId(
  channel: ChannelKey,
  product: ChannelModelProduct,
  talabatChannelProductId?: string | null,
): { externalId: string | null; source: ExternalIdSource } {
  switch (channel) {
    case "snoonu":
      return { externalId: product.snoonu_id, source: product.snoonu_id ? "products_column" : "none" };
    case "pure_seoul":
      return { externalId: product.pure_seoul_id, source: product.pure_seoul_id ? "products_column" : "none" };
    case "rafeeq":
      return { externalId: product.rafeeq_product_id, source: product.rafeeq_product_id ? "products_column" : "none" };
    case "talabat": {
      const id = talabatChannelProductId ?? null;
      return { externalId: id, source: id ? "channel_variant_mappings" : "none" };
    }
    case "shopify":
      // No durable id persisted; Shopify is matched live by SKU/title each run.
      return { externalId: null, source: "live_match" };
  }
}

/**
 * Project ONE product across all five channels into the unified read-model.
 * Pure: classifies the supplied rows; never reads or writes anything.
 */
export function projectProductChannels(input: ProjectChannelsInput): ProductChannelProjection[] {
  const { product } = input;
  return CHANNEL_KEYS.map((channel): ProductChannelProjection => {
    const { externalId, source } = resolveChannelExternalId(channel, product, input.talabatChannelProductId);
    const overlay = input.overlay?.[channel];
    const ps = input.platformStatus?.[channel];
    const hasOverride = overlay?.channel_price != null;
    return {
      productId: product.id,
      channel,
      label: CHANNEL_LABELS[channel],
      availabilityMode: channelAvailabilityMode(channel),
      externalId,
      externalIdSource: source,
      // Shopify's live-match still counts as "mappable" (SKU/title), so a Shopify
      // row is present-by-identity; the other channels require a persisted id.
      mappingPresent: channel === "shopify" ? true : externalId != null,
      listingStatus: overlay?.channel_status ?? null,
      listingSource: overlay?.channel_status != null ? "channel_products" : "none",
      approval: ps?.approval ?? null,
      availability: ps?.availability ?? null,
      availabilitySource: ps?.availability != null ? "platform_status" : "none",
      channelPrice: overlay?.channel_price ?? null,
      priceSource: hasOverride ? "channel_override" : "internal_base",
    };
  });
}
