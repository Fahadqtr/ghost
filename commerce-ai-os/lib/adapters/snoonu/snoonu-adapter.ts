// CH.6A — Snoonu multi-store adapter FOUNDATION (PURE factory, dependency-injected).
//
// The first real non-Shopify ChannelAdapter. Snoonu owns TWO storefronts from day
// one — snoonu:malikas and snoonu:pure_seoul — and the adapter requires the
// storefront to be EXPLICIT on every call (Malikas vs Pure Seoul is never
// inferred). Identity resolution goes through the CH.5 ECL resolver only
// (identity_type = snoonu_spi, storefront-scoped; SPIs are never deduped across
// stores).
//
// FOUNDATION ONLY: identity resolution is live; the mutating / connector
// capabilities (listings, catalog/image/availability/price sync, publish,
// orders) are declared but report supports()=false and a not-implemented outcome
// — they arrive in CH.6B–F. The adapter performs NO writes.
//
// PURE: the resolver is injected; no DB/network/@/ imports. node:test loads it.

import {
  type AdapterCapability,
  type ChannelAdapter,
  type ChannelIdentity,
  type ExternalIdentityResolver,
  type ExternalListingRef,
  type InternalProductRef,
  type ListingsOutcome,
  type OrderIngestOptions,
  type OrderIngestOutcome,
  type PublishOutcome,
  type StoreRef,
  type SyncOutcome,
} from "../types.ts";
import { storefrontsForChannel } from "../../channels/storefronts.ts";

const CHANNEL = "snoonu" as const;

// Snoonu's two storefronts, as CH.4 StoreRefs (from the CH.5 registry).
const SNOONU_STORES: readonly StoreRef[] = storefrontsForChannel(CHANNEL).map((sf) => ({
  channel: CHANNEL,
  storeId: sf.key,
  storeKey: sf.key,
  label: sf.label,
  listingGrain: sf.listingGrain,
}));

// CH.6A implements identity only; the rest land in later CH.6 phases.
const LIVE_CAPABILITIES: readonly AdapterCapability[] = ["identity"];

export interface SnoonuAdapterDeps {
  /** CH.5 ECL-backed resolver (storefront-scoped, snoonu_spi). */
  resolver: ExternalIdentityResolver;
  /** Override stores (defaults to the two registry storefronts). */
  stores?: readonly StoreRef[];
}

const KNOWN = (stores: readonly StoreRef[], store: StoreRef): boolean =>
  store.channel === CHANNEL && stores.some((s) => s.storeKey === store.storeKey);

const notImplementedSync = (): SyncOutcome => ({
  ok: false, processed: 0, updated: 0, failed: 0,
  errors: ["snoonu: capability not implemented in CH.6A (foundation)"], degraded: true,
});
const notImplementedPublish = (): PublishOutcome => ({
  ok: false, changed: 0, failed: 0, errors: ["snoonu: capability not implemented in CH.6A (foundation)"],
});

export function createSnoonuAdapter(deps: SnoonuAdapterDeps): ChannelAdapter {
  const stores = deps.stores ?? SNOONU_STORES;

  const adapter: ChannelAdapter = {
    channel: CHANNEL,

    identity(): ChannelIdentity {
      return { channel: CHANNEL, label: "Snoonu", capabilities: LIVE_CAPABILITIES, stores };
    },
    stores() {
      return stores;
    },
    supports(cap: AdapterCapability): boolean {
      return LIVE_CAPABILITIES.includes(cap);
    },

    // LIVE — storefront-scoped identity via the CH.5 ECL resolver. The store
    // (Malikas vs Pure Seoul) is explicit in the StoreRef; unknown stores return
    // an empty ref rather than guessing.
    resolveListing(store: StoreRef, product: InternalProductRef): Promise<ExternalListingRef> {
      if (!KNOWN(stores, store)) {
        return Promise.resolve({ storeKey: store.storeKey, externalListingId: null, source: "none" });
      }
      return deps.resolver.resolve(store, product);
    },

    // FUTURE (CH.6B–F) — declared, not implemented; never mutate.
    async listListings(_store: StoreRef): Promise<ListingsOutcome> {
      return { ok: false, listings: [], error: "snoonu: merchant connector arrives in CH.6B" };
    },
    async syncCatalog(): Promise<SyncOutcome> { return notImplementedSync(); },
    async syncImages(): Promise<SyncOutcome> { return notImplementedSync(); },       // CH.6B
    async syncAvailability(): Promise<SyncOutcome> { return notImplementedSync(); }, // CH.6C
    async syncPrices(): Promise<SyncOutcome> { return notImplementedSync(); },
    async publish(): Promise<PublishOutcome> { return notImplementedPublish(); },
    async unpublish(): Promise<PublishOutcome> { return notImplementedPublish(); },
    async ingestOrders(_store: StoreRef, _opts?: OrderIngestOptions): Promise<OrderIngestOutcome> {
      return { ok: false, ingested: 0, skipped: 0, errors: ["snoonu: order ingestion not in CH.6A"] };
    },
  };

  return adapter;
}

export { SNOONU_STORES };
