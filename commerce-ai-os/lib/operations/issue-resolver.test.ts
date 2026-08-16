// OPS.7 — issue → resolver routing tests. PURE (no DB/network/render).
// node --conditions=react-server --experimental-strip-types --test lib/operations/issue-resolver.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import {
  PLATFORM_STOREFRONT,
  RESOLVER_ROUTES,
  resolveIssueHref,
  resolveWorkQueueHref,
  channelRowHref,
  productDetailHref,
  missingProductsHref,
} from "./issue-resolver.ts";
import { STOREFRONT_KEYS } from "../channels/storefronts.ts";
import type { CrossPlatformIssue } from "./operations-queue.ts";
import type { PlatformType } from "./shared/models.ts";

const issue = (over: Partial<CrossPlatformIssue>): CrossPlatformIssue =>
  ({
    productId: "p1",
    sku: "SKU1",
    barcode: null,
    nameAr: null,
    nameEn: null,
    imageUrl: null,
    platform: "shopify",
    label: "Shopify",
    state: "missing",
    severity: "high",
    reason: "not_listed",
    flags: [],
    capturedAt: null,
    stale: false,
    ...over,
  }) as CrossPlatformIssue;

// ── every mapped storefront is a real CH.5 storefront ─────────────────────────
test("PLATFORM_STOREFRONT maps every platform to a registered storefront key", () => {
  for (const [platform, key] of Object.entries(PLATFORM_STOREFRONT)) {
    assert.ok(STOREFRONT_KEYS.includes(key), `${platform} → ${key} is a registered storefront`);
  }
});

// ── issue → resolver matrix ───────────────────────────────────────────────────
test("not_listed → Missing Products filtered by the issue's storefront", () => {
  assert.equal(resolveIssueHref(issue({ platform: "shopify", reason: "not_listed" })), missingProductsHref("shopify:malikas"));
  assert.equal(resolveIssueHref(issue({ platform: "rafeeq", reason: "not_listed" })), missingProductsHref("rafeeq:malikas"));
});

test("needs_review → Missing Products with storefront + status=NEEDS_REVIEW", () => {
  const href = resolveIssueHref(issue({ platform: "talabat", reason: "needs_review" }));
  assert.equal(href, missingProductsHref("talabat:malikas", "NEEDS_REVIEW"));
  assert.ok(href.includes("storefront=talabat%3Amalikas") && href.includes("status=NEEDS_REVIEW"));
});

test("drifted → Availability Sync for Snoonu storefronts; product-detail fallback otherwise", () => {
  // puresoul → snoonu:pure_seoul is an availability storefront
  assert.equal(
    resolveIssueHref(issue({ platform: "puresoul", reason: "drifted", productId: "p9" })),
    `${RESOLVER_ROUTES.availabilitySync}?storefront=snoonu%3Apure_seoul`,
  );
  // shopify drift has no V2 apply resolver → product detail fallback
  assert.equal(resolveIssueHref(issue({ platform: "shopify", reason: "drifted", productId: "p9" })), productDetailHref("p9"));
});

test("staged_not_live → Channel Command Center filtered by storefront", () => {
  assert.equal(
    resolveIssueHref(issue({ platform: "rafeeq", reason: "staged_not_live" })),
    `${RESOLVER_ROUTES.channels}?storefront=rafeeq%3Amalikas`,
  );
});

test("unknown platform → safe product-detail fallback (never throws)", () => {
  const href = resolveIssueHref(issue({ platform: "weird" as PlatformType, productId: "pX" }));
  assert.equal(href, productDetailHref("pX"));
});

// ── storefront isolation: a resolver href never leaks another storefront ───────
test("storefront isolation — each platform routes only to its own storefront", () => {
  const cases: [PlatformType, string][] = [
    ["shopify", "shopify%3Amalikas"],
    ["puresoul", "snoonu%3Apure_seoul"],
    ["talabat", "talabat%3Amalikas"],
    ["rafeeq", "rafeeq%3Amalikas"],
  ];
  const others = ["shopify%3Amalikas", "snoonu%3Apure_seoul", "talabat%3Amalikas", "rafeeq%3Amalikas"];
  for (const [platform, own] of cases) {
    const href = resolveIssueHref(issue({ platform, reason: "not_listed" }));
    assert.ok(href.includes(own), `${platform} routes to ${own}`);
    for (const other of others) {
      if (other !== own) assert.ok(!href.includes(other), `${platform} must not leak ${other}`);
    }
  }
});

// ── work-queue category routing ───────────────────────────────────────────────
test("work-queue rows route by category; unknown → product detail", () => {
  assert.equal(resolveWorkQueueHref("needs_image", "p1"), RESOLVER_ROUTES.media);
  assert.equal(resolveWorkQueueHref("needs_review", "p1"), missingProductsHref(null, "NEEDS_REVIEW"));
  assert.equal(resolveWorkQueueHref("platform_issues", "p1"), RESOLVER_ROUTES.missingProducts);
  assert.equal(resolveWorkQueueHref("new", "p1"), productDetailHref("p1"));
  assert.equal(resolveWorkQueueHref("ready", "p2"), productDetailHref("p2"));
});

// ── channel-health row deep-link ──────────────────────────────────────────────
test("channelRowHref pre-filters Missing Products to the storefront", () => {
  assert.equal(channelRowHref("snoonu:malikas"), missingProductsHref("snoonu:malikas"));
  assert.ok(channelRowHref("shopify:malikas").startsWith(`${RESOLVER_ROUTES.missingProducts}?storefront=`));
});

// ── missingProductsHref only forwards a REAL storefront key ───────────────────
test("missingProductsHref drops an unregistered storefront (never forwards junk)", () => {
  assert.equal(missingProductsHref("not-a-storefront"), RESOLVER_ROUTES.missingProducts);
  assert.equal(missingProductsHref("shopify:malikas"), `${RESOLVER_ROUTES.missingProducts}?storefront=shopify%3Amalikas`);
});
