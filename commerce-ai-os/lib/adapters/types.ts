// CH.4 — Channel Adapter Framework: generic contracts (PURE).
//
// One interface every sales channel implements, so catalog/image/availability/
// price/publish/order flows are driven the SAME way regardless of channel. This
// module is the CONTRACT only — it holds no channel logic, no DB, no network.
//
// The four-level model the framework is built around:
//
//     Channel  →  Store  →  External Listing  →  Internal Product
//
//   - Channel: shopify | talabat | snoonu | pure_seoul | rafeeq (CH.2 keys).
//   - Store:   a distinct storefront WITHIN a channel. A channel may have MANY.
//              Shopify has one today; Snoonu will have "Malika's" + "Pure Seoul";
//              Rafeeq will have its own; Talabat will flatten variants into
//              standalone listings (listingGrain = "variant").
//   - External Listing: the channel's own product/variant handle for a store.
//   - Internal Product: our master catalog product (+ optional variant).
//
// PURE: the only import is the pure CH.2 channel-model (keys + id-source
// vocabulary). No @/ imports, no server-only, no DB/React/next — node:test loads
// it directly.

import { type ChannelKey, type ExternalIdSource } from "../channels/channel-model.ts";

export type { ChannelKey, ExternalIdSource };

// ── Capabilities ──────────────────────────────────────────────────────────────
// The nine operations every adapter declares (an adapter may `supports()===false`
// for one it cannot perform — e.g. a future read-only channel).
export const ADAPTER_CAPABILITIES = [
  "identity",
  "listings",
  "catalogSync",
  "imageSync",
  "availabilitySync",
  "priceSync",
  "publish",
  "unpublish",
  "orderIngestion",
] as const;
export type AdapterCapability = (typeof ADAPTER_CAPABILITIES)[number];

// ── Channel → Store → External Listing → Internal Product ─────────────────────

/** A distinct storefront within a channel. A channel may expose several. */
export interface StoreRef {
  channel: ChannelKey;
  /** Stable internal identifier for the store (maps to a channels row later). */
  storeId: string;
  /** Stable slug, unique across ALL adapters, e.g. "shopify:main", "snoonu:pure_seoul". */
  storeKey: string;
  label: string;
  /**
   * Grain at which this store lists our catalog:
   *   - "product":  one external listing per master product (Shopify/Snoonu/Rafeeq)
   *   - "variant":  each variant is flattened into its own standalone listing (Talabat)
   */
  listingGrain: "product" | "variant";
}

/** A master-catalog product (and, for variant-grain stores, a specific variant). */
export interface InternalProductRef {
  productId: string;
  sku?: string | null;
  /** Set only when the target store's listingGrain === "variant". */
  variantSku?: string | null;
}

/** A pointer to the channel's own handle for one internal product, in one store. */
export interface ExternalListingRef {
  storeKey: string;
  /** The channel's durable listing id; null when not yet listed or matched live. */
  externalListingId: string | null;
  /** Optional variant-level handle (variant-grain stores). */
  externalVariantId?: string | null;
  /** Where the id came from (reuses the CH.2 mapping-graph vocabulary). */
  source: ExternalIdSource;
}

/** One listing as read back FROM the channel (read-model of the external side). */
export interface ExternalListing {
  externalListingId: string;
  title: string | null;
  sku: string | null;
  status: string | null;
}

// ── Uniform result shapes ─────────────────────────────────────────────────────

/** Result of the sync family (catalog/image/availability/price). */
export interface SyncOutcome {
  ok: boolean;
  processed: number;
  updated: number;
  failed: number;
  errors: string[];
  /** true when the channel/store was unreachable or unconfigured (never partial). */
  degraded?: boolean;
}

export interface ListingsOutcome {
  ok: boolean;
  listings: ExternalListing[];
  error?: string;
}

export interface PublishOutcome {
  ok: boolean;
  changed: number;
  failed: number;
  errors: string[];
}

export interface OrderIngestOptions {
  /** Only ingest orders newer than this many hours (channel-dependent default). */
  sinceHours?: number;
  limit?: number;
}

/**
 * Result of order INGESTION only — normalizing/counting the channel's recent
 * orders. Stock deduction is NOT part of ingestion: it stays owned by the
 * Inventory Engine / order RPCs (out of the adapter's scope by design).
 */
export interface OrderIngestOutcome {
  ok: boolean;
  ingested: number;
  skipped: number;
  errors: string[];
}

// ── Identity ──────────────────────────────────────────────────────────────────

export interface ChannelIdentity {
  channel: ChannelKey;
  label: string;
  capabilities: readonly AdapterCapability[];
  stores: readonly StoreRef[];
}

/**
 * Abstract read access to the CH.2 shared mapping layer (products external-id
 * columns + channel_products + platform_status + channel_variant_mappings). The
 * framework depends ONLY on this interface — it creates no new mapping tables.
 * CH.5.5 will replace the backing storage without touching adapters.
 */
export interface ExternalIdentityResolver {
  resolve(store: StoreRef, product: InternalProductRef): Promise<ExternalListingRef>;
}

// ── The adapter contract ──────────────────────────────────────────────────────

export interface ChannelAdapter {
  readonly channel: ChannelKey;

  /** Static description: channel, label, supported capabilities, and stores. */
  identity(): ChannelIdentity;
  /** The stores this adapter manages (>= 1). Store-awareness lives here. */
  stores(): readonly StoreRef[];
  /** Whether a capability is implemented by this adapter. */
  supports(cap: AdapterCapability): boolean;

  /** Translate an internal product to its external listing pointer (via CH.2). */
  resolveListing(store: StoreRef, product: InternalProductRef): Promise<ExternalListingRef>;

  /** Read the channel's listings for a store. */
  listListings(store: StoreRef): Promise<ListingsOutcome>;

  /** Push catalog fields (titles / descriptions / status metadata). */
  syncCatalog(store: StoreRef, products: InternalProductRef[]): Promise<SyncOutcome>;
  /** Push product images. */
  syncImages(store: StoreRef, products: InternalProductRef[]): Promise<SyncOutcome>;
  /** Push availability (in/out of stock or quantity, per channel policy). */
  syncAvailability(store: StoreRef, products: InternalProductRef[]): Promise<SyncOutcome>;
  /** Push prices (base or channel override). */
  syncPrices(store: StoreRef, products: InternalProductRef[]): Promise<SyncOutcome>;

  /** Make products live on the store (create/activate the listing). */
  publish(store: StoreRef, products: InternalProductRef[]): Promise<PublishOutcome>;
  /** Take products off the store (deactivate/draft the listing). */
  unpublish(store: StoreRef, products: InternalProductRef[]): Promise<PublishOutcome>;

  /** Ingest (normalize + count) the store's recent orders. Never deducts stock. */
  ingestOrders(store: StoreRef, opts?: OrderIngestOptions): Promise<OrderIngestOutcome>;
}

/** Runtime-usable list of the adapter's method names, for guard tests. */
export const CAPABILITY_METHODS: Record<AdapterCapability, keyof ChannelAdapter> = {
  identity: "identity",
  listings: "listListings",
  catalogSync: "syncCatalog",
  imageSync: "syncImages",
  availabilitySync: "syncAvailability",
  priceSync: "syncPrices",
  publish: "publish",
  unpublish: "unpublish",
  orderIngestion: "ingestOrders",
};
