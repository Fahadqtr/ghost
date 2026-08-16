// OPS.7 — Operations issue → resolver routing (PURE).
//
// Turns an operations issue into the href of the EXISTING workflow that resolves
// it, with validated storefront/status filters. This is routing/orchestration
// only: it introduces no new screen, duplicates no detection, and reads/writes
// nothing. Unknown or unresolvable issues fall back to the product-detail page
// so the operator always lands somewhere safe.
//
// PURE: only `import type` from sibling pure modules (erased at runtime) + the
// canonical storefront registry (a pure relative import). node:test loads it.

import type { PlatformType } from "./shared/models.ts";
import type { CrossPlatformIssue, QueueKey } from "./operations-queue.ts";
import { STOREFRONT_KEYS } from "../channels/storefronts.ts";

// Existing routes only — never a parallel screen.
export const RESOLVER_ROUTES = {
  missingProducts: "/v2/operations/missing-products",
  availabilitySync: "/v2/operations/availability-sync",
  channels: "/v2/operations/channels",
  media: "/v2/operations/media",
  ai: "/v2/operations/ai-enrichment",
  barcode: "/v2/operations/barcode-completion",
  catalog: "/v2/catalog",
} as const;

// The two Snoonu storefronts the availability-sync workflow accepts (it is the
// only V2 apply path for availability/price drift, and it is Snoonu-only).
const AVAILABILITY_STOREFRONTS: readonly string[] = ["snoonu:malikas", "snoonu:pure_seoul"];

// Platform (matrix cell) → canonical storefront key. Kept in sync with the CH.5
// storefront registry (a unit test asserts every mapped key is registered).
export const PLATFORM_STOREFRONT: Record<PlatformType, string> = {
  shopify: "shopify:malikas",
  puresoul: "snoonu:pure_seoul",
  talabat: "talabat:malikas",
  rafeeq: "rafeeq:malikas",
};

/** Product-detail page — the safe fallback for anything without a filtered resolver. */
export function productDetailHref(productId: string): string {
  return `${RESOLVER_ROUTES.catalog}/${encodeURIComponent(productId)}`;
}

/** Missing-Products, optionally pre-filtered to a storefront (+ status). */
export function missingProductsHref(storefrontKey?: string | null, status?: string | null): string {
  const params: string[] = [];
  if (storefrontKey && STOREFRONT_KEYS.includes(storefrontKey)) params.push(`storefront=${encodeURIComponent(storefrontKey)}`);
  if (status) params.push(`status=${encodeURIComponent(status)}`);
  return params.length ? `${RESOLVER_ROUTES.missingProducts}?${params.join("&")}` : RESOLVER_ROUTES.missingProducts;
}

/**
 * The resolver href for a single cross-platform issue. Maps the issue's platform
 * to its storefront and its reason to the workflow that fixes that reason:
 *   • not_listed      → Missing Products (import/link), filtered by storefront
 *   • needs_review    → Missing Products, storefront + status=NEEDS_REVIEW
 *   • drifted         → Availability Sync (Snoonu only); other channels fall back
 *   • staged_not_live → Channel Command Center, filtered by storefront
 * Any unmapped platform/reason → product-detail fallback.
 */
export function resolveIssueHref(issue: Pick<CrossPlatformIssue, "productId" | "platform" | "reason">): string {
  const fallback = productDetailHref(issue.productId);
  const key = PLATFORM_STOREFRONT[issue.platform] ?? null;
  if (!key) return fallback;
  switch (issue.reason) {
    case "not_listed":
      return missingProductsHref(key);
    case "needs_review":
      return missingProductsHref(key, "NEEDS_REVIEW");
    case "drifted":
      return AVAILABILITY_STOREFRONTS.includes(key)
        ? `${RESOLVER_ROUTES.availabilitySync}?storefront=${encodeURIComponent(key)}`
        : fallback; // Shopify/Talabat/Rafeeq drift has no V2 apply resolver yet
    case "staged_not_live":
      return `${RESOLVER_ROUTES.channels}?storefront=${encodeURIComponent(key)}`;
    default:
      return fallback;
  }
}

/**
 * The resolver href for a catalog-quality work-queue row. Category → workflow:
 *   • needs_image     → Media Center
 *   • needs_review    → Missing Products (status=NEEDS_REVIEW)
 *   • platform_issues → Missing Products (all storefronts)
 *   • everything else → product-detail fallback (new / ready / high_priority)
 */
export function resolveWorkQueueHref(queueKey: QueueKey | string, productId: string): string {
  switch (queueKey) {
    case "needs_image":
      return RESOLVER_ROUTES.media;
    case "needs_review":
      return missingProductsHref(null, "NEEDS_REVIEW");
    case "platform_issues":
      return RESOLVER_ROUTES.missingProducts;
    default:
      return productDetailHref(productId);
  }
}

/** The channel-health row deep-link: the storefront's Missing-Products view. */
export function channelRowHref(storefrontKey: string): string {
  return missingProductsHref(storefrontKey);
}
