// Test fixtures for the operations engines (imported by *.test.ts only).
// A COMPLETE, APPROVED product by default; tests override what they break.

import type { OperationsProduct, PlatformPresence } from "./models";

export function makeProduct(overrides: Partial<OperationsProduct> = {}): OperationsProduct {
  return {
    id: "p1",
    sku: "mk123",
    barcode: "6291041500213",
    nameAr: "كريم مرطب",
    nameEn: "Hydrating Cream",
    descriptionAr: "وصف عربي",
    descriptionEn: "english description",
    brandId: "b1",
    category: "Korean Skincare",
    price: 45,
    imageUrl: "https://cdn.example.test/mk123.jpg",
    approval: "Approved",
    platformStatus: "shopify",
    variantCount: 0,
    // expectsVariants deliberately omitted: unknown is the default reality
    ...overrides,
  };
}

/** A TRUSTED snapshot; default = the reader looked and found nothing. */
export function presence(overrides: Partial<PlatformPresence> = {}): PlatformPresence {
  return { linked: false, live: false, drift: false, reviewRequired: false, ...overrides };
}

/** Trusted confirmed-absent snapshots for ALL platforms. */
export function absentOnAllPlatforms() {
  return { shopify: presence(), puresoul: presence(), talabat: presence(), rafeeq: presence() };
}
