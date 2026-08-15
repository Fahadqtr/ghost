// CH.4 — External identity resolver backed by the CH.2 shared mapping layer (PURE).
//
// Adapters must translate an internal product into its external listing pointer
// without knowing HOW the mapping is stored. This provides that translation on
// top of the CH.2 read-model (`loadProductChannelProjection`) — abstracting
// access only. It creates NO new mapping tables; CH.5.5 will swap the backing
// store by supplying a different loader, with adapters unchanged.
//
// PURE: the loader is injected (dependency inversion), so this module has no DB
// and no server-only import — node:test drives it with a fake loader. The real
// server wiring passes the CH.2 reader bound to a session client.

import {
  type ChannelKey,
  type ProductChannelProjection,
} from "../channels/channel-model.ts";
import {
  type ExternalIdentityResolver,
  type ExternalListingRef,
  type InternalProductRef,
  type StoreRef,
} from "./types.ts";

/** The CH.2 reader's return shape (product-grain projection across channels). */
export interface ProjectionRead {
  projections: ProductChannelProjection[];
  degraded: boolean;
}

/** A loader that yields the CH.2 projection for one product (e.g. the bound reader). */
export type ProjectionLoader = (productId: string) => Promise<ProjectionRead>;

/**
 * Build an ExternalIdentityResolver from a CH.2 projection loader.
 * Picks the projection for the store's channel and exposes its external id +
 * source. Degraded reads resolve to a null id with source "none" — never an
 * invented mapping.
 */
export function createProjectionIdentityResolver(load: ProjectionLoader): ExternalIdentityResolver {
  return {
    async resolve(store: StoreRef, product: InternalProductRef): Promise<ExternalListingRef> {
      const channel: ChannelKey = store.channel;
      let read: ProjectionRead;
      try {
        read = await load(product.productId);
      } catch {
        return { storeKey: store.storeKey, externalListingId: null, source: "none" };
      }
      if (read.degraded) {
        return { storeKey: store.storeKey, externalListingId: null, source: "none" };
      }
      const proj = read.projections.find((p) => p.channel === channel) ?? null;
      if (!proj) {
        return { storeKey: store.storeKey, externalListingId: null, source: "none" };
      }
      return {
        storeKey: store.storeKey,
        externalListingId: proj.externalId,
        source: proj.externalIdSource,
      };
    },
  };
}
