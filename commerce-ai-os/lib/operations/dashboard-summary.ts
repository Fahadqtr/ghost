// Malikas V2 Operations — Dashboard summary layer (Phase UI.8).
//
// PURE: aggregates the ALREADY-COMPUTED engine outputs (OperationsListItem[] +
// HealthSummary) into the executive dashboard's KPIs, queues and platform
// overview. No database, no fetch, no clock, no randomness — and NO business
// logic: readiness/tasks/health/platform rules stay in lib/operations/* engines;
// this only counts and groups their results. Everything here runs server-side so
// only the KPIs, per-queue top items and counts cross to the browser — never the
// whole catalog.

import type { HealthSummary, PlatformStatusValue } from "./shared/models";
import type { OperationsListItem } from "./dashboard-view";

// ── TickTick annotation ──────────────────────────────────────────────────────

/**
 * Annotate each item with how many of its computed tasks are mirrored in
 * TickTick (matched by the deterministic marker == OperationTask id). Pure:
 * derives `ticktickSyncedCount` from the provided synced-id set; an empty set
 * (TickTick not connected / unavailable) yields 0 everywhere. Never mutates the
 * inputs and never touches readiness/tasks.
 */
export function annotateTickTick(
  items: readonly OperationsListItem[],
  syncedIds: ReadonlySet<string>,
): OperationsListItem[] {
  return items.map((item) => ({
    ...item,
    ticktickSyncedCount: item.tasks.reduce((n, t) => (syncedIds.has(t.id) ? n + 1 : n), 0),
  }));
}

// ── KPIs ─────────────────────────────────────────────────────────────────────

export interface DashboardKpis {
  totalProducts: number;
  newProducts: number;
  needsImage: number;
  needsReview: number;
  ready: number;
  totalTasks: number;
  highPriorityTasks: number;
  readinessAverage: number;
  shopifyMissing: number;
  shopifyDifferent: number;
  ticktickLinkedTasks: number;
}

function shopifyStatusOf(item: OperationsListItem): PlatformStatusValue | null {
  return item.platforms.find((p) => p.platform === "shopify")?.status ?? null;
}

/** Compute the 11 header KPIs. Totals/ready/new/needsImage/average come straight
 *  from HealthSummary (the engine's own aggregate); the rest are counts over the
 *  already-computed items. Items are expected to be TickTick-annotated. */
export function buildKpis(
  items: readonly OperationsListItem[],
  health: HealthSummary,
): DashboardKpis {
  let highPriorityTasks = 0;
  let needsReview = 0;
  let shopifyMissing = 0;
  let shopifyDifferent = 0;
  let ticktickLinkedTasks = 0;
  for (const item of items) {
    if (item.needsReview) needsReview++;
    for (const t of item.tasks) if (t.priority === "high") highPriorityTasks++;
    const s = shopifyStatusOf(item);
    if (s === "missing") shopifyMissing++;
    else if (s === "different") shopifyDifferent++;
    ticktickLinkedTasks += item.ticktickSyncedCount ?? 0;
  }
  return {
    totalProducts: health.totalProducts,
    newProducts: health.newProducts,
    needsImage: health.needsImage,
    needsReview,
    ready: health.readyProducts,
    totalTasks: health.generatedTasks,
    highPriorityTasks,
    readinessAverage: health.readinessAverage,
    shopifyMissing,
    shopifyDifferent,
    ticktickLinkedTasks,
  };
}

// ── Queues ───────────────────────────────────────────────────────────────────

export type QueueKey =
  | "new"
  | "needs_image"
  | "needs_review"
  | "ready"
  | "platform_issues"
  | "high_priority";

/** A compact product row for a queue — deliberately smaller than the full list
 *  item (no tasks/platforms arrays), so a queue never ships heavy data. */
export interface QueueItem {
  id: string;
  sku: string | null;
  nameAr: string | null;
  nameEn: string | null;
  imageUrl: string | null;
  readinessPercent: number;
  taskCount: number;
}

export interface Queue {
  key: QueueKey;
  /** total matching products across the WHOLE catalog (not just the shown top) */
  total: number;
  /** the top N items only (bounded) */
  items: QueueItem[];
}

/** The map filter each queue's "عرض الكل" link points at. Kept here so the UI
 *  never re-derives the queue→filter relationship. */
export const QUEUE_FILTER: Record<QueueKey, string> = {
  new: "new",
  needs_image: "needs_image",
  needs_review: "needs_review",
  ready: "ready",
  platform_issues: "shopify_missing",
  high_priority: "high_priority",
};

export const DEFAULT_QUEUE_TOP = 5;

function toQueueItem(i: OperationsListItem): QueueItem {
  return {
    id: i.id,
    sku: i.sku,
    nameAr: i.nameAr,
    nameEn: i.nameEn,
    imageUrl: i.imageUrl,
    readinessPercent: i.readinessPercent,
    taskCount: i.taskCount,
  };
}

/** A "platform issue" is a TRUSTED negative Shopify verdict — missing / drifted /
 *  needs-review. `unknown` (not connected) is NEVER an issue. */
function isPlatformIssue(item: OperationsListItem): boolean {
  const s = shopifyStatusOf(item);
  return s === "missing" || s === "different" || s === "review_required";
}

const QUEUE_PREDICATES: Record<QueueKey, (i: OperationsListItem) => boolean> = {
  new: (i) => i.isNew,
  needs_image: (i) => i.needsImage,
  needs_review: (i) => i.needsReview,
  ready: (i) => i.readinessStatus === "ready",
  platform_issues: isPlatformIssue,
  high_priority: (i) => i.tasks.some((t) => t.priority === "high"),
};

export const QUEUE_ORDER: readonly QueueKey[] = [
  "new",
  "needs_image",
  "needs_review",
  "ready",
  "platform_issues",
  "high_priority",
];

/** Build all queues: each carries the FULL count + only the top N compact items. */
export function buildQueues(
  items: readonly OperationsListItem[],
  top: number = DEFAULT_QUEUE_TOP,
): Queue[] {
  return QUEUE_ORDER.map((key) => {
    const matched = items.filter(QUEUE_PREDICATES[key]);
    return { key, total: matched.length, items: matched.slice(0, Math.max(0, top)).map(toQueueItem) };
  });
}

// ── Platform overview ────────────────────────────────────────────────────────

export interface ShopifyOverview {
  available: boolean;
  published: number;
  missing: number;
  different: number;
  reviewRequired: number;
  ready: number;
}

/** PureSoul overview (Phase UI.9.3) — counted from the snapshot-derived
 *  `item.puresoulState` (classified in lib, never in the UI). `different` equals
 *  `priceDifferent` this phase (price is the only field comparePureSeoul
 *  compares; name-diff is not reliably available). `unknown` is surfaced but is
 *  NEVER treated as missing. Freshness comes from the latest capture. */
export interface PureSoulOverview {
  available: boolean;
  published: number;
  missing: number;
  different: number;
  priceDifferent: number;
  reviewRequired: number;
  outOfStock: number;
  unknown: number;
  lastCapturedAt: string | null;
  stale: boolean;
}

/** Freshness/availability of the PureSoul snapshot read, passed through to the
 *  overview (computed by the server-side snapshot reader). */
export interface PureSoulMeta {
  available: boolean;
  lastCapturedAt: string | null;
  stale: boolean;
}

export interface PlatformOverview {
  shopify: ShopifyOverview;
  puresoul: PureSoulOverview;
  /** Talabat / Rafeeq have no reader yet → not connected (never counted as
   *  missing). Future phases add their adapters. */
  talabat: "not_connected";
  rafeeq: "not_connected";
}

const EMPTY_PURESOUL_META: PureSoulMeta = { available: false, lastCapturedAt: null, stale: false };

/** Summarise platform presence. Shopify + PureSoul have trusted readers; their
 *  statuses are counted from the items. Unknown is NEVER folded into "missing". */
export function buildPlatformOverview(
  items: readonly OperationsListItem[],
  shopifyAvailable: boolean,
  puresoulMeta: PureSoulMeta = EMPTY_PURESOUL_META,
): PlatformOverview {
  const shopify: ShopifyOverview = {
    available: shopifyAvailable,
    published: 0,
    missing: 0,
    different: 0,
    reviewRequired: 0,
    ready: 0,
  };
  const puresoul: PureSoulOverview = {
    available: puresoulMeta.available,
    published: 0,
    missing: 0,
    different: 0,
    priceDifferent: 0,
    reviewRequired: 0,
    outOfStock: 0,
    unknown: 0,
    lastCapturedAt: puresoulMeta.lastCapturedAt,
    stale: puresoulMeta.stale,
  };
  for (const item of items) {
    switch (shopifyStatusOf(item)) {
      case "published":
        shopify.published++;
        break;
      case "missing":
        shopify.missing++;
        break;
      case "different":
        shopify.different++;
        break;
      case "review_required":
        shopify.reviewRequired++;
        break;
      case "ready":
        shopify.ready++;
        break;
      default:
        break; // "unknown" / null → not counted
    }
    switch (item.puresoulState) {
      case "published":
        puresoul.published++;
        break;
      case "missing":
        puresoul.missing++;
        break;
      case "price_different":
        puresoul.priceDifferent++;
        puresoul.different++; // price is the only compared field this phase
        break;
      case "review":
        puresoul.reviewRequired++;
        break;
      case "out_of_stock":
        puresoul.outOfStock++;
        break;
      default:
        puresoul.unknown++; // "unknown" / undefined — surfaced, never "missing"
        break;
    }
  }
  return { shopify, puresoul, talabat: "not_connected", rafeeq: "not_connected" };
}

// ── one-shot summary ─────────────────────────────────────────────────────────

export interface DashboardSummary {
  kpis: DashboardKpis;
  queues: Queue[];
  platformOverview: PlatformOverview;
}

/** Assemble the whole executive summary from annotated items + health. Pure. */
export function buildDashboardSummary(
  items: readonly OperationsListItem[],
  health: HealthSummary,
  shopifyAvailable: boolean,
  puresoulMeta: PureSoulMeta = EMPTY_PURESOUL_META,
  queueTop: number = DEFAULT_QUEUE_TOP,
): DashboardSummary {
  return {
    kpis: buildKpis(items, health),
    queues: buildQueues(items, queueTop),
    platformOverview: buildPlatformOverview(items, shopifyAvailable, puresoulMeta),
  };
}
