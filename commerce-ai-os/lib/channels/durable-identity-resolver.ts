// CH.5 — durable external-listing resolver (PURE, dependency-injected).
//
// Implements the CH.4 ExternalIdentityResolver interface (so adapters need not
// know storage changed) AND the richer CH.5 API: resolveExternalListing /
// resolveInternalListing, each returning provenance + store-aware mapping health.
//
// Backed by external_channel_listings through an injected read PORT — no DB here,
// so node:test drives it with fakes. NO fuzzy / name fallback (§8): resolution is
// by durable identity only. Never returns quantity (§11).

import {
  type ChannelKey,
  type ExternalIdSource,
} from "./channel-model.ts";
import {
  type ExternalIdentityResolver,
  type ExternalListingRef,
  type InternalProductRef,
  type StoreRef,
} from "../adapters/types.ts";
import {
  type ExternalListingRecord,
  type IdentityType,
  type MappingHealth,
} from "./external-listing-identity.ts";

/** Read port over external_channel_listings (durable identity only, read-only). */
export interface ExternalListingReaderPort {
  /** All listings for one internal product across storefronts. */
  byProduct(productId: string): Promise<ExternalListingRecord[]>;
  /** Listings matching an external handle within one storefront. */
  byExternalId(
    storefrontKey: string,
    externalProductId: string | null,
    externalVariantId: string | null,
  ): Promise<ExternalListingRecord[]>;
  /** Listings matching an exported SKU within one storefront (Talabat grain). */
  bySku(storefrontKey: string, sku: string): Promise<ExternalListingRecord[]>;
  /**
   * Optional: needs_review rows whose CONTESTED external id (kept in
   * metadata.claimed_external_product_id, not the unique column) equals the
   * lookup id. Lets the resolver surface NEEDS_REVIEW for a duplicate external
   * id instead of a misleading "unmapped" — without ever picking one product.
   */
  byClaimedExternalId?(storefrontKey: string, claimedExternalProductId: string): Promise<ExternalListingRecord[]>;
}

export type ResolutionStatus = "resolved" | "unmapped" | "ambiguous" | "needs_review";

export interface Provenance {
  source: "external_channel_listings";
  storefrontKey: string;
  identityType?: IdentityType;
}

export interface ExternalListingResolution {
  status: ResolutionStatus;
  listing: ExternalListingRecord | null;
  candidates: ExternalListingRecord[];
  health: MappingHealth;
  provenance: Provenance;
}

export interface InternalListingResolution {
  status: ResolutionStatus;
  productId: string | null;
  variantId: string | null;
  variantSku: string | null;
  health: MappingHealth;
  provenance: Provenance;
}

export interface ResolveExternalQuery {
  productId: string;
  variantId?: string | null;
  channel: ChannelKey;
  storefront: string;
}

export interface ResolveInternalQuery {
  channel: ChannelKey;
  storefront: string;
  externalProductId?: string | null;
  externalVariantId?: string | null;
  sku?: string | null;
  barcode?: string | null;
}

export interface DurableIdentityResolver extends ExternalIdentityResolver {
  resolveExternalListing(q: ResolveExternalQuery): Promise<ExternalListingResolution>;
  resolveInternalListing(q: ResolveInternalQuery): Promise<InternalListingResolution>;
}

const s = (v: string | null | undefined): string => (v ?? "").trim();

function statusOf(rows: ExternalListingRecord[]): ResolutionStatus {
  if (rows.length === 0) return "unmapped";
  if (rows.length > 1) return "ambiguous";
  return rows[0].mappingStatus === "needs_review" ? "needs_review" : "resolved";
}

function healthOf(status: ResolutionStatus): MappingHealth {
  switch (status) {
    case "resolved": return "HEALTHY";
    case "unmapped": return "UNMAPPED";
    case "ambiguous": return "AMBIGUOUS";
    case "needs_review": return "NEEDS_REVIEW";
  }
}

/** Map an identity type to the closest CH.4 ExternalIdSource (interface compat). */
function idSource(identityType: IdentityType | undefined): ExternalIdSource {
  switch (identityType) {
    case "shopify_gid": return "live_match";
    case "snoonu_spi":
    case "rafeeq_product_id": return "products_column";
    case "talabat_sku": return "channel_variant_mappings";
    default: return "none";
  }
}

export function createDurableIdentityResolver(port: ExternalListingReaderPort): DurableIdentityResolver {
  async function resolveExternalListing(q: ResolveExternalQuery): Promise<ExternalListingResolution> {
    const all = await port.byProduct(q.productId);
    let rows = all.filter((r) => r.storefrontKey === q.storefront);
    if (q.variantId != null) rows = rows.filter((r) => s(r.variantId) === s(q.variantId));
    const status = statusOf(rows);
    return {
      status,
      listing: status === "resolved" || status === "needs_review" ? rows[0] : null,
      candidates: rows,
      health: healthOf(status),
      provenance: { source: "external_channel_listings", storefrontKey: q.storefront, identityType: rows[0]?.identityType },
    };
  }

  async function resolveInternalListing(q: ResolveInternalQuery): Promise<InternalListingResolution> {
    // Durable identity only — no fuzzy/name fallback.
    let rows: ExternalListingRecord[] = [];
    if (s(q.externalProductId) || s(q.externalVariantId)) {
      rows = await port.byExternalId(q.storefront, s(q.externalProductId) || null, s(q.externalVariantId) || null);
    } else if (s(q.sku)) {
      rows = await port.bySku(q.storefront, s(q.sku));
    }
    // A duplicate external id lives in needs_review rows with a NULL unique
    // external_product_id (the contested id is in metadata). Surface it as
    // NEEDS_REVIEW so the caller never treats a real conflict as "unmapped" and
    // never picks a product.
    if (rows.length === 0 && s(q.externalProductId) && port.byClaimedExternalId) {
      const claimed = await port.byClaimedExternalId(q.storefront, s(q.externalProductId));
      if (claimed.length > 0) {
        return {
          status: "needs_review",
          productId: null,
          variantId: null,
          variantSku: null,
          health: "NEEDS_REVIEW",
          provenance: { source: "external_channel_listings", storefrontKey: q.storefront, identityType: claimed[0].identityType },
        };
      }
    }
    const status = statusOf(rows);
    const hit = status === "resolved" || status === "needs_review" ? rows[0] : null;
    return {
      status,
      productId: hit?.productId ?? null,
      variantId: hit?.variantId ?? null,
      variantSku: hit?.variantSku ?? null,
      health: healthOf(status),
      provenance: { source: "external_channel_listings", storefrontKey: q.storefront, identityType: hit?.identityType },
    };
  }

  // CH.4 ExternalIdentityResolver compat — adapters keep calling .resolve().
  async function resolve(store: StoreRef, product: InternalProductRef): Promise<ExternalListingRef> {
    // Product-grain resolution for the CH.4 compat path (adapters translate a
    // product to its storefront listing). Variant-grain callers use the richer
    // resolveExternalListing({ variantId }) directly.
    const res = await resolveExternalListing({
      productId: product.productId,
      channel: store.channel,
      storefront: store.storeKey,
    });
    const listing = res.listing;
    return {
      storeKey: store.storeKey,
      externalListingId: listing?.externalProductId ?? null,
      externalVariantId: listing?.externalVariantId ?? null,
      source: listing ? idSource(listing.identityType) : "none",
    };
  }

  return { resolve, resolveExternalListing, resolveInternalListing };
}
