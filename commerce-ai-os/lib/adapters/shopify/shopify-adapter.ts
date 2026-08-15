// CH.4 — Shopify reference adapter (PURE factory, dependency-injected).
//
// The FIRST implementation of the ChannelAdapter contract. It owns Shopify's
// identity, store list, capability set, internal→external id resolution (via the
// injected CH.2 resolver), and the translation of Shopify's native result shapes
// into the framework's uniform outcomes.
//
// It contains NO Shopify business logic of its own: every side-effecting call is
// an INJECTED dependency that the server wiring binds to the existing, already-
// tested Shopify functions (diff/push/inventory-sync/orders). This is what keeps
// the framework free of logic duplication and lets node:test drive the adapter
// with fakes. No @/ imports, no server-only, no network here.

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
  ADAPTER_CAPABILITIES,
} from "../types.ts";
import { SHOPIFY_STORES } from "./store.ts";

// ── Native Shopify result shapes (as the existing functions already return) ─────
export interface ShopifyNativeApply {
  ok: boolean;
  error?: string;
  updated: number;
  failed: { name: string; error: string }[];
}
export interface ShopifyNativeBulk {
  ok: boolean;
  error?: string;
  created: number;
  skipped: number;
  failed: { name: string; error: string }[];
}
export interface ShopifyNativeInventory {
  ok: boolean;
  error?: string;
  matched: number;
  updated: number;
}
export interface ShopifyNativeListings {
  products?: { externalListingId: string; title: string | null; sku: string | null; status: string | null }[];
  error?: string;
}
export interface ShopifyNativeOrders {
  ok: boolean;
  error?: string;
  ingested: number;
  skipped: number;
}

export interface ShopifyAdapterDeps {
  /** CH.2-backed internal→external id translation. */
  resolver: ExternalIdentityResolver;
  /** Override the store list (defaults to the single Shopify store). */
  stores?: readonly StoreRef[];
  listListings: (store: StoreRef) => Promise<ShopifyNativeListings>;
  syncCatalog: (productIds: string[]) => Promise<ShopifyNativeApply>;
  syncImages: (productIds: string[]) => Promise<ShopifyNativeApply>;
  /** Shopify inventory sync is store-global; the product list is advisory. */
  syncAvailability: (productIds: string[]) => Promise<ShopifyNativeInventory>;
  syncPrices: (productIds: string[]) => Promise<ShopifyNativeApply>;
  publish: (productIds: string[]) => Promise<ShopifyNativeBulk>;
  unpublish: (productIds: string[]) => Promise<ShopifyNativeApply>;
  ingestOrders: (opts?: OrderIngestOptions) => Promise<ShopifyNativeOrders>;
}

const CHANNEL = "shopify" as const;

const ids = (products: InternalProductRef[]): string[] =>
  [...new Set(products.map((p) => p.productId).filter(Boolean))];

const failMessages = (failed: { name: string; error: string }[]): string[] =>
  failed.map((f) => `${f.name}: ${f.error}`);

/** Wrong-channel / unknown-store guard → a degraded (never partial) outcome. */
function storeOk(adapter: ChannelAdapter, store: StoreRef): boolean {
  return store.channel === CHANNEL && adapter.stores().some((s) => s.storeKey === store.storeKey);
}

const syncFromApply = (native: ShopifyNativeApply, processed: number): SyncOutcome => ({
  ok: native.ok,
  processed,
  updated: native.updated,
  failed: native.failed.length,
  errors: [...(native.error ? [native.error] : []), ...failMessages(native.failed)],
  degraded: !native.ok && native.updated === 0 && native.failed.length === 0,
});

export function createShopifyAdapter(deps: ShopifyAdapterDeps): ChannelAdapter {
  const stores = deps.stores ?? SHOPIFY_STORES;

  const adapter: ChannelAdapter = {
    channel: CHANNEL,

    identity(): ChannelIdentity {
      return {
        channel: CHANNEL,
        label: "Shopify",
        capabilities: ADAPTER_CAPABILITIES,
        stores,
      };
    },

    stores() {
      return stores;
    },

    supports(_cap: AdapterCapability): boolean {
      // The reference adapter implements every capability.
      return true;
    },

    resolveListing(store: StoreRef, product: InternalProductRef): Promise<ExternalListingRef> {
      return deps.resolver.resolve(store, product);
    },

    async listListings(store: StoreRef): Promise<ListingsOutcome> {
      if (!storeOk(adapter, store)) return { ok: false, listings: [], error: "unknown store" };
      const native = await deps.listListings(store);
      if (native.error) return { ok: false, listings: [], error: native.error };
      return { ok: true, listings: native.products ?? [] };
    },

    async syncCatalog(store: StoreRef, products: InternalProductRef[]): Promise<SyncOutcome> {
      if (!storeOk(adapter, store)) return degraded(products.length);
      const list = ids(products);
      return syncFromApply(await deps.syncCatalog(list), list.length);
    },

    async syncImages(store: StoreRef, products: InternalProductRef[]): Promise<SyncOutcome> {
      if (!storeOk(adapter, store)) return degraded(products.length);
      const list = ids(products);
      return syncFromApply(await deps.syncImages(list), list.length);
    },

    async syncAvailability(store: StoreRef, products: InternalProductRef[]): Promise<SyncOutcome> {
      if (!storeOk(adapter, store)) return degraded(products.length);
      const list = ids(products);
      const native = await deps.syncAvailability(list);
      return {
        ok: native.ok,
        processed: native.matched,
        updated: native.updated,
        failed: 0,
        errors: native.error ? [native.error] : [],
        degraded: !native.ok,
      };
    },

    async syncPrices(store: StoreRef, products: InternalProductRef[]): Promise<SyncOutcome> {
      if (!storeOk(adapter, store)) return degraded(products.length);
      const list = ids(products);
      return syncFromApply(await deps.syncPrices(list), list.length);
    },

    async publish(store: StoreRef, products: InternalProductRef[]): Promise<PublishOutcome> {
      if (!storeOk(adapter, store)) return { ok: false, changed: 0, failed: products.length, errors: ["unknown store"] };
      const native = await deps.publish(ids(products));
      return {
        ok: native.ok,
        changed: native.created,
        failed: native.failed.length,
        errors: [...(native.error ? [native.error] : []), ...failMessages(native.failed)],
      };
    },

    async unpublish(store: StoreRef, products: InternalProductRef[]): Promise<PublishOutcome> {
      if (!storeOk(adapter, store)) return { ok: false, changed: 0, failed: products.length, errors: ["unknown store"] };
      const native = await deps.unpublish(ids(products));
      return {
        ok: native.ok,
        changed: native.updated,
        failed: native.failed.length,
        errors: [...(native.error ? [native.error] : []), ...failMessages(native.failed)],
      };
    },

    async ingestOrders(store: StoreRef, opts?: OrderIngestOptions): Promise<OrderIngestOutcome> {
      if (!storeOk(adapter, store)) return { ok: false, ingested: 0, skipped: 0, errors: ["unknown store"] };
      const native = await deps.ingestOrders(opts);
      return {
        ok: native.ok,
        ingested: native.ingested,
        skipped: native.skipped,
        errors: native.error ? [native.error] : [],
      };
    },
  };

  return adapter;
}

const degraded = (processed: number): SyncOutcome => ({
  ok: false,
  processed,
  updated: 0,
  failed: 0,
  errors: ["unknown store"],
  degraded: true,
});
