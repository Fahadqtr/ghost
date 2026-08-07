// Malikas V2 Operations — New Product Engine (Phase UI.7.1).
//
// PURE: classifies the CURRENT catalog snapshot into operational buckets.
// Nothing is stored; a product may appear in more than one bucket (e.g. a
// new product that is also missing its image) — each bucket is an
// independent view, which is exactly what the dashboard tiles need.

import type { NewProductBuckets, ProductReadiness } from "../shared/models";

/**
 * Bucket a catalog snapshot by its readiness results.
 * - newProducts   : never approved and never pushed to a platform
 * - readyProducts : fully publishable now (readyToPublish)
 * - needsImage    : the image check failed
 * - needsReview   : the readiness engine demands a human look
 */
export function classifyNewProducts(entries: readonly ProductReadiness[]): NewProductBuckets {
  const buckets: NewProductBuckets = {
    newProducts: [],
    readyProducts: [],
    needsImage: [],
    needsReview: [],
  };
  for (const r of entries) {
    if (r.isNew) buckets.newProducts.push(r.productId);
    if (r.readyToPublish) buckets.readyProducts.push(r.productId);
    if (r.checks.some((c) => c.code === "image" && !c.passed)) buckets.needsImage.push(r.productId);
    if (r.status === "needs_review") buckets.needsReview.push(r.productId);
  }
  return buckets;
}
