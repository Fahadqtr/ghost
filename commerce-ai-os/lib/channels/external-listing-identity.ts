// CH.5 — Durable external-listing identity model (PURE).
//
// One record per (internal product/variant → storefront → external listing).
// A single internal product may have MANY external listings across storefronts,
// each with channel-appropriate identity semantics. Storage is normalized; the
// MEANING of the identity differs by channel and is preserved via identityType.
//
// This module owns: the record shape, the uniqueness keys, per-storefront
// identity-type rules, and the (derived) mapping-health classification. It owns
// NO quantity — external listings never carry stock (§11).
//
// PURE: imports only pure siblings (storefronts + channel keys). node:test loads
// it directly.

import { type ChannelKey } from "./channel-model.ts";
import {
  type IdentityType,
  type ListingGrain,
  storefrontByKey,
} from "./storefronts.ts";

export type { IdentityType };

// Stored lifecycle status (mirrors channel_variant_mappings.mapping_status).
export type MappingStatus = "active" | "needs_review" | "archived";

// Derived, store-aware mapping HEALTH (CH.2 semantics, canonicalized for CH.5).
export type MappingHealth =
  | "HEALTHY" //       identity present, internal target exists, unique, active
  | "UNMAPPED" //      no external identity recorded for this (product, storefront)
  | "STALE" //         exported SKU no longer matches the internal variant's SKU
  | "AMBIGUOUS" //     the external identity resolves to more than one internal target
  | "ORPHANED" //      identity present but the internal product/variant is gone
  | "NEEDS_REVIEW"; // non-deterministic mapping — a human must decide (never guessed)

/** One durable external-listing identity row (mirrors external_channel_listings). */
export interface ExternalListingRecord {
  id?: string;
  /** Internal master product (authoritative catalog). */
  productId: string;
  /** Internal variant id, when the listing is variant-grain (else null). */
  variantId: string | null;
  /** Durable variant grain key — the variant SKU (variant ids are not stable). */
  variantSku: string | null;
  channelKey: ChannelKey;
  storefrontKey: string;
  /** Channel's durable product handle (Shopify GID / Snoonu SPI / Rafeeq id). */
  externalProductId: string | null;
  /** Channel's variant handle (Shopify variant GID); null otherwise. */
  externalVariantId: string | null;
  /** SKU as exported to the channel (Talabat's practical listing key). */
  exportedSku: string | null;
  exportedBarcode: string | null;
  identityType: IdentityType;
  mappingStatus: MappingStatus;
  metadata?: Record<string, unknown>;
}

const norm = (v: string | null | undefined): string => (v ?? "").trim();

/**
 * INTERNAL uniqueness key — one listing per (storefront, internal product,
 * variant grain). Lets Shopify keep a product-grain row (variantId null) PLUS
 * per-variant rows, while Talabat keeps one row per flattened variant.
 */
export function internalUniquenessKey(r: Pick<ExternalListingRecord, "storefrontKey" | "productId" | "variantId" | "variantSku">): string {
  // Includes variant_sku so Talabat's flattened variant rows (variant_id null,
  // distinct variant_sku) stay distinct, while a product-grain row (both null)
  // is unique per (storefront, product).
  return `${r.storefrontKey}::${r.productId}::${norm(r.variantId)}::${norm(r.variantSku)}`;
}

/**
 * EXTERNAL identity uniqueness key — one internal target per external handle in
 * a storefront. Storefront-scoped, so Snoonu Malikas SPI-A and Snoonu Pure Seoul
 * SPI-B never collide even for the same product. Returns null when no durable
 * external handle exists (Talabat pre-assignment / unmapped), so those rows are
 * excluded from external-id uniqueness (they use the SKU key instead).
 */
export function externalIdentityKey(r: Pick<ExternalListingRecord, "storefrontKey" | "externalProductId" | "externalVariantId">): string | null {
  if (!norm(r.externalProductId) && !norm(r.externalVariantId)) return null;
  return `${r.storefrontKey}::${norm(r.externalProductId)}::${norm(r.externalVariantId)}`;
}

/**
 * SKU-grain identity key — the practical listing key for Talabat (and any
 * SKU-keyed storefront). Storefront-scoped. Null when no exported SKU.
 */
export function skuIdentityKey(r: Pick<ExternalListingRecord, "storefrontKey" | "exportedSku">): string | null {
  const sku = norm(r.exportedSku);
  return sku ? `${r.storefrontKey}::${sku.toLowerCase()}` : null;
}

/** Does the identityType match what the storefront declares? (normalize storage, keep meaning) */
export function identityTypeMatchesStorefront(storefrontKey: string, identityType: IdentityType): boolean {
  const sf = storefrontByKey(storefrontKey);
  return sf ? sf.identityType === identityType : false;
}

/** The listing grain a storefront expects (variant for Talabat, product elsewhere). */
export function storefrontGrain(storefrontKey: string): ListingGrain | null {
  return storefrontByKey(storefrontKey)?.listingGrain ?? null;
}

// ── Mapping health classification (pure, store-aware) ──────────────────────────

export interface HealthContext {
  /** Does the internal master product still exist? */
  productExists: boolean;
  /** Does the internal variant still exist? (only meaningful for variant grain) */
  variantExists?: boolean;
  /** The internal variant's CURRENT sku, to detect exported-SKU drift. */
  currentVariantSku?: string | null;
  /** How many internal targets this external identity resolves to (>1 ⇒ ambiguous). */
  internalTargetsForExternalId?: number;
  /** How many external rows share this internal target in the storefront (>1 ⇒ ambiguous). */
  externalRowsForInternal?: number;
}

/**
 * Classify one record's health. Deterministic and conservative: anything not
 * provably HEALTHY degrades to a specific state — never a silent pass. No fuzzy
 * or name-based reasoning.
 */
export function classifyListingHealth(record: ExternalListingRecord, ctx: HealthContext): MappingHealth {
  if (record.mappingStatus === "needs_review") return "NEEDS_REVIEW";

  const hasExternal = !!norm(record.externalProductId) || !!norm(record.externalVariantId) || !!norm(record.exportedSku);
  if (!hasExternal) return "UNMAPPED";

  // Ambiguity dominates: a handle that points to several internals (or vice
  // versa) is unsafe to act on.
  if ((ctx.internalTargetsForExternalId ?? 1) > 1) return "AMBIGUOUS";
  if ((ctx.externalRowsForInternal ?? 1) > 1) return "AMBIGUOUS";

  // The internal target vanished under a live external mapping.
  if (!ctx.productExists) return "ORPHANED";
  if (record.variantSku !== null && ctx.variantExists === false) return "ORPHANED";

  // Exported SKU drifted from the internal variant's current SKU.
  if (
    record.exportedSku !== null &&
    ctx.currentVariantSku != null &&
    norm(record.exportedSku).toLowerCase() !== norm(ctx.currentVariantSku).toLowerCase()
  ) {
    return "STALE";
  }

  return "HEALTHY";
}
