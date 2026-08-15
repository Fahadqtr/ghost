// CH.5 Phase D — legacy storefront resolver (PURE, dependency-injected).
//
// The DIAGNOSTIC fallback for dual-read: resolves an internal product to its
// legacy external id straight from the products.*_id columns, mapped by
// STOREFRONT (so the two Snoonu storefronts read their own column). Used ONLY to
// compare against the durable ECL resolver during the switch-over — it is never
// authoritative and is retired with the legacy columns in Phase E.
//
// PURE: the column loader is injected; no DB here.

import { type ExternalIdSource } from "./channel-model.ts";
import {
  type ExternalIdentityResolver,
  type ExternalListingRef,
  type InternalProductRef,
  type StoreRef,
} from "../adapters/types.ts";

/** The legacy denormalized id columns for one product. */
export interface LegacyProductColumns {
  snoonu_id: string | null;
  pure_seoul_id: string | null;
  rafeeq_product_id: string | null;
}

export type LegacyColumnLoader = (productId: string) => Promise<LegacyProductColumns | null>;

const s = (v: string | null | undefined): string | null => {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
};

/** storefront key → (legacy column, CH.4 id source). Shopify/Talabat have none. */
function columnFor(storeKey: string): { pick: (c: LegacyProductColumns) => string | null; source: ExternalIdSource } | null {
  switch (storeKey) {
    case "snoonu:malikas":    return { pick: (c) => c.snoonu_id, source: "products_column" };
    case "snoonu:pure_seoul": return { pick: (c) => c.pure_seoul_id, source: "products_column" };
    case "rafeeq:malikas":    return { pick: (c) => c.rafeeq_product_id, source: "products_column" };
    default:                  return null; // shopify:malikas (live-match) / talabat:malikas (cvm) have no legacy column
  }
}

export function createLegacyStorefrontResolver(load: LegacyColumnLoader): ExternalIdentityResolver {
  return {
    async resolve(store: StoreRef, product: InternalProductRef): Promise<ExternalListingRef> {
      const map = columnFor(store.storeKey);
      if (!map) return { storeKey: store.storeKey, externalListingId: null, source: "none" };
      let cols: LegacyProductColumns | null;
      try { cols = await load(product.productId); } catch { cols = null; }
      const id = cols ? s(map.pick(cols)) : null;
      return { storeKey: store.storeKey, externalListingId: id, source: id ? map.source : "none" };
    },
  };
}
