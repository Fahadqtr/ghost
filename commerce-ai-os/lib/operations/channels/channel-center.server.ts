import "server-only";
// OPS.3 — Channel Command Center assembler (SERVER-ONLY, READ-ONLY).
//
// One read-only assembly for /v2/operations/channels. It performs the SAME single
// aggregated read the main /v2/operations page performs (loadOperationsDashboard)
// — NOT a per-card scan (§17) — then feeds the already-computed aggregates into
// the PURE channel-center composer. It issues NO writes: only select/eq/order/
// range through the injected readers, and (on an explicit search only) exact ECL
// identity look-ups via the durable resolver. Every mutation is delegated to an
// existing writer-gated workflow by link in the pure composer.

import { createClient } from "@/lib/supabase/server";
import { isSignedIn } from "@/lib/auth/requireUser";
import { safeError } from "@/lib/security/safe-error";
import { loadOperationsDashboard } from "@/lib/operations/read-model";
import { loadShopifyPresence } from "@/lib/operations/shopify-presence";
import { loadShopifySnapshotView } from "@/lib/platforms/shopify/snapshot-presence";
import { loadPureSoulPresence } from "@/lib/platforms/puresoul/presence";
import { loadPureSoulSnapshotView } from "@/lib/platforms/puresoul/snapshot-presence";
import { loadTalabatSnapshotView } from "@/lib/platforms/talabat/snapshot-presence";
import { loadRafeeqSnapshotView } from "@/lib/platforms/rafeeq/snapshot-presence";
import { buildDashboardSummary } from "@/lib/operations/dashboard-summary";
import { buildPlatformHealth } from "@/lib/operations/platform-health";
import type { OperationsListItem } from "@/lib/operations/dashboard-view";
import { createDurableIdentityResolver } from "@/lib/channels/durable-identity-resolver";
import { createExternalListingReader } from "@/lib/channels/external-listing-reader";
import { STOREFRONTS } from "@/lib/channels/storefronts";
import { channelKeyFromName } from "@/lib/channels/channel-model";
import {
  buildChannelCenter,
  buildChannelQueues,
  filterAlerts,
  filterItems,
  filterStorefrontCards,
  searchLocal,
  selectQueue,
  EMPTY_FILTERS,
  type ChannelAlert,
  type ChannelFilters,
  type ChannelQueue,
  type CcItem,
  type CcOverview,
  type ChannelCenterInput,
  type ChannelCenterModel,
  type SearchMatch,
  type SearchResult,
  type StorefrontCard,
} from "./channel-center.ts";

const NOT_SIGNED_IN = "غير مسجّل الدخول.";
const LOAD_FAILED = "تعذّر تحميل مركز القنوات.";
const MAX_EXTERNAL_MATCHES = 10;

export interface ChannelCenterView {
  /** the full (unfiltered) model — used for filter options, activity, quick actions,
   *  the overall roll-up and counts. */
  model: ChannelCenterModel;
  /** the filtered storefront-first views the active filters select. */
  filtered: { storefronts: StorefrontCard[]; alerts: ChannelAlert[]; queues: ChannelQueue[] };
  filters: ChannelFilters;
  search: SearchResult | null;
  degraded: boolean;
}

function shopifyStatusOf(item: OperationsListItem): string | null {
  return item.platforms.find((p) => p.platform === "shopify")?.status ?? null;
}

function toCcItem(i: OperationsListItem): CcItem {
  return {
    id: i.id,
    sku: i.sku,
    barcode: i.barcode,
    nameAr: i.nameAr,
    nameEn: i.nameEn,
    brandId: (i as { brandId?: string | null }).brandId ?? null,
    category: (i as { category?: string | null }).category ?? null,
    readinessPercent: i.readinessPercent,
    needsImage: i.needsImage,
    needsReview: i.needsReview,
    reasons: i.reasons,
    shopifyStatus: shopifyStatusOf(i),
    puresoulState: i.puresoulState,
    talabatState: i.talabatState,
    rafeeqState: i.rafeeqState,
  };
}

/**
 * Resolve an external identifier (SPI / Shopify GID / Rafeeq product id / Talabat
 * SKU) to internal products via the DURABLE ECL resolver — exact identity only,
 * NEVER fuzzy (§13). Best-effort and bounded: any failure degrades to no external
 * matches. Read-only (the reader issues select/eq only).
 */
async function resolveExternalIdentity(
  client: ReturnType<typeof createClient>,
  rawQuery: string,
  itemsById: ReadonlyMap<string, OperationsListItem>,
): Promise<SearchMatch[]> {
  const token = rawQuery.trim();
  if (token === "") return [];
  try {
    const resolver = createDurableIdentityResolver(
      createExternalListingReader(client as unknown as Parameters<typeof createExternalListingReader>[0]),
    );
    const matches: SearchMatch[] = [];
    const seen = new Set<string>();
    for (const sf of STOREFRONTS) {
      const channel = channelKeyFromName(sf.channel);
      if (!channel) continue;
      // Talabat identity is SKU-based; every other storefront is external-id-based.
      const query =
        sf.identityType === "talabat_sku"
          ? { channel, storefront: sf.key, sku: token }
          : { channel, storefront: sf.key, externalProductId: token };
      const res = await resolver.resolveInternalListing(query);
      if (res.status === "resolved" && res.productId && !seen.has(res.productId)) {
        seen.add(res.productId);
        const item = itemsById.get(res.productId);
        matches.push({
          id: res.productId,
          sku: item?.sku ?? res.variantSku ?? null,
          name: item ? item.nameAr ?? item.nameEn : null,
          matchedOn: "external",
          storefront: sf.key,
          externalId: token,
        });
        if (matches.length >= MAX_EXTERNAL_MATCHES) break;
      }
    }
    return matches;
  } catch {
    return [];
  }
}

export async function loadChannelCenter(
  opts?: { query?: string | null; filters?: ChannelFilters },
): Promise<ChannelCenterView | { error: string }> {
  if (!(await isSignedIn())) return { error: NOT_SIGNED_IN };
  try {
    const supabase = createClient();
    const result = await loadOperationsDashboard(supabase as never, {
      shopify: { loadShopifyPresence },
      shopifySnapshot: { loadShopifySnapshotView: (c) => loadShopifySnapshotView(c as never) },
      puresoul: { loadPureSoulPresence: (c) => loadPureSoulPresence(c as never) },
      puresoulSnapshot: { loadPureSoulSnapshotView: (c) => loadPureSoulSnapshotView(c as never) },
      talabatSnapshot: { loadTalabatSnapshotView: (c) => loadTalabatSnapshotView(c as never) },
      rafeeqSnapshot: { loadRafeeqSnapshotView: (c) => loadRafeeqSnapshotView(c as never) },
    });
    if (result.status !== "ok") return { error: LOAD_FAILED };

    const items = result.data.items;
    const summary = buildDashboardSummary(
      items,
      result.data.health,
      result.data.shopifyAvailable,
      { available: result.data.puresoulAvailable, lastCapturedAt: result.data.puresoulLastCapturedAt, stale: result.data.puresoulStale },
      undefined,
      { lastCapturedAt: result.data.shopifyLastCapturedAt, stale: result.data.shopifyStale },
      { available: result.data.talabatAvailable, lastCapturedAt: result.data.talabatLastCapturedAt, stale: result.data.talabatStale },
      { available: result.data.rafeeqAvailable, lastCapturedAt: result.data.rafeeqLastCapturedAt, stale: result.data.rafeeqStale },
    );

    const platformHealth = buildPlatformHealth(
      summary.platformOverview,
      summary.kpis.totalProducts,
      { puresoul: result.data.puresoulDegraded, talabat: result.data.talabatDegraded, rafeeq: result.data.rafeeqDegraded },
      new Date().getTime(),
    );

    const ov = summary.platformOverview;
    const overview: CcOverview = {
      shopify: { available: ov.shopify.available, published: ov.shopify.published, missing: ov.shopify.missing, different: ov.shopify.different, reviewRequired: ov.shopify.reviewRequired, stale: ov.shopify.stale, lastCapturedAt: ov.shopify.lastCapturedAt },
      puresoul: { available: ov.puresoul.available, published: ov.puresoul.published, missing: ov.puresoul.missing, priceDifferent: ov.puresoul.priceDifferent, reviewRequired: ov.puresoul.reviewRequired, outOfStock: ov.puresoul.outOfStock, stale: ov.puresoul.stale, lastCapturedAt: ov.puresoul.lastCapturedAt },
      talabat: { available: ov.talabat.available, present: ov.talabat.present, missing: ov.talabat.missing, review: ov.talabat.review, linked: ov.talabat.linked, stale: ov.talabat.stale, lastCapturedAt: ov.talabat.lastCapturedAt },
      rafeeq: { available: ov.rafeeq.available, present: ov.rafeeq.present, missing: ov.rafeeq.missing, linked: ov.rafeeq.linked, stale: ov.rafeeq.stale, lastCapturedAt: ov.rafeeq.lastCapturedAt },
    };

    const ccItems: CcItem[] = items.map(toCcItem);
    const input: ChannelCenterInput = {
      kpis: {
        totalProducts: summary.kpis.totalProducts,
        needsImage: summary.kpis.needsImage,
        needsReview: summary.kpis.needsReview,
        ready: summary.kpis.ready,
        readinessAverage: summary.kpis.readinessAverage,
      },
      overview,
      platformHealth: platformHealth.map((h) => ({ platform: h.platform, freshnessState: h.freshnessState, healthLevel: h.healthLevel, reasons: h.reasons })),
      items: ccItems,
      degraded: { puresoul: result.data.puresoulDegraded, talabat: result.data.talabatDegraded, rafeeq: result.data.rafeeqDegraded },
      // No snoonu:malikas presence/snapshot reader is wired (CH.CERT) — stays
      // OPERATIONALLY_BLOCKED. rafeeqConflicts is intentionally left unset (the
      // dashboard has no cheap live source; conflict review is a workflow queue).
      snoonuMalikasReaderAvailable: false,
    };

    const model = buildChannelCenter(input);

    // Active filters (§14) — applied purely over the composed model. Card/alert
    // filters are storefront-first; brand/category re-scope the item-level queues.
    const filters = opts?.filters ?? EMPTY_FILTERS;
    const queuesBase =
      filters.brand || filters.category
        ? buildChannelQueues({ ...input, items: filterItems(ccItems, filters) })
        : model.queues;
    const filtered = {
      storefronts: filterStorefrontCards(model.storefronts, filters),
      alerts: filterAlerts(model.alerts, filters),
      queues: selectQueue(queuesBase, filters.issueType),
    };

    // Global search (§13): local identity match is pure over the loaded items;
    // external identity is resolved on demand via the ECL resolver. No fuzzy.
    let search: SearchResult | null = null;
    const q = (opts?.query ?? "").trim();
    if (q !== "") {
      const local = searchLocal(ccItems, q);
      const byId = new Map(items.map((i) => [i.id, i] as const));
      const external = await resolveExternalIdentity(supabase, q, byId);
      // never double-report a product already found locally
      const localIds = new Set(local.map((m) => m.id));
      search = { query: q, local, external: external.filter((m) => !localIds.has(m.id)) };
    }

    return { model, filtered, filters, search, degraded: result.data.partial };
  } catch (e) {
    return { error: safeError("ops3_channels_load", e, LOAD_FAILED) };
  }
}
