// CH.4 — Shopify store definitions (PURE).
//
// Shopify has ONE store today. It is declared as a StoreRef list so the
// framework's store-awareness holds from day one: nothing in the Shopify adapter
// assumes "one store per channel". When a channel needs several stores, it simply
// returns several StoreRefs here — e.g. later:
//   Snoonu  → [snoonu:malikas, snoonu:pure_seoul]   (listingGrain "product")
//   Talabat → [talabat:main]                         (listingGrain "variant")
//   Rafeeq  → [rafeeq:main]                          (listingGrain "product")

import { type StoreRef } from "../types.ts";

export const SHOPIFY_MAIN_STORE: StoreRef = {
  channel: "shopify",
  storeId: "shopify:main",
  storeKey: "shopify:main",
  label: "Shopify (Malika's Universe)",
  listingGrain: "product",
};

/** All Shopify stores (one today; the list shape supports more without changes). */
export const SHOPIFY_STORES: readonly StoreRef[] = [SHOPIFY_MAIN_STORE];
