// Malikas V2 Operations — Dashboard view layer (Phase UI.7.2).
//
// PURE: projects the engine outputs into client-safe list items and provides
// filter / search / pagination over them. No database, no fetch, no clock.
// The page computes health/buckets/tasks server-side and sends ONLY the
// current page of items to the browser (never the whole catalog).
//
// Business logic is NOT re-implemented here — it consumes ProductReadiness,
// OperationTask and PlatformStatus produced by lib/operations/* engines.

import type {
  OperationsProduct,
  OperationTask,
  PlatformPresence,
  PlatformStatus,
  PlatformStatusValue,
  PlatformType,
  ProductReadiness,
} from "./shared/models";
import type { PureSoulState } from "@/lib/platforms/puresoul/capture-compute";
import type { TalabatState } from "@/lib/platforms/talabat/capture-compute";

/** One product row as the dashboard renders it — catalog-safe, no PII. */
export interface OperationsListItem {
  id: string;
  sku: string | null;
  barcode: string | null;
  nameAr: string | null;
  nameEn: string | null;
  price: number | null;
  imageUrl: string | null;
  readinessPercent: number;
  readinessStatus: ProductReadiness["status"];
  reasons: string[];
  isNew: boolean;
  needsImage: boolean;
  needsReview: boolean;
  taskCount: number;
  tasks: OperationTask[];
  platforms: PlatformStatus[];
  /**
   * How many of this product's COMPUTED tasks are currently mirrored in TickTick
   * (matched by the deterministic marker). Enriched server-side from a best-effort
   * TickTick read (0 when TickTick is not connected / unavailable) — it never
   * changes readiness/tasks, it only annotates. `> 0` ⇒ "synced" for the UI.
   */
  ticktickSyncedCount?: number;
  /**
   * PureSoul state derived from the latest persisted snapshot (Phase UI.9.3),
   * falling back to the live overlay, else undefined (→ Unknown). Enriched
   * server-side; it annotates only (never changes readiness/tasks). Missing /
   * price_different come ONLY from a trusted snapshot — never from absence.
   */
  puresoulState?: PureSoulState;
  /**
   * Talabat state (Phase UI.9.6): present/missing/review from the latest trusted
   * UPLOAD snapshot; else `linked` (ready) from a confirmed channel mapping; else
   * undefined (→ Unknown). Enriched server-side; annotates only. Missing comes
   * ONLY from a trusted upload verdict — never from absence, staleness, or a
   * mapping alone (a mapping is never "present"/"published").
   */
  talabatState?: TalabatState;
}

/** Map a whitelisted DB row (+ its variant count and optional Shopify
 *  presence) into an OperationsProduct. Pure and defensive — unknown/blank
 *  cells become null; expectsVariants stays UNKNOWN (the reader has no
 *  trusted source for it yet). */
export function mapProductRow(
  row: Record<string, unknown>,
  variantCount: number,
  platforms?: Partial<Record<PlatformType, PlatformPresence>>,
): OperationsProduct {
  const s = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
  const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    id: typeof row.id === "string" ? row.id : "",
    sku: s(row.sku),
    barcode: s(row.barcode),
    nameAr: s(row.name_ar),
    nameEn: s(row.name_en),
    descriptionAr: s(row.description_ar),
    descriptionEn: s(row.description_en),
    brandId: s(row.brand_id),
    category: s(row.main_category),
    price: n(row.price),
    imageUrl: s(row.image_url),
    approval: s(row.approval),
    platformStatus: s(row.platform_status),
    variantCount: Number.isFinite(variantCount) && variantCount > 0 ? variantCount : 0,
    // expectsVariants deliberately omitted — no trusted source (see UI.7.1)
    ...(platforms ? { platforms } : {}),
  };
}

export type OperationsFilter =
  | "all"
  | "new"
  | "needs_image"
  | "needs_review"
  | "ready"
  | "high_priority"
  | "has_tasks"
  | "shopify_missing"
  | "shopify_different"
  | "ticktick_synced"
  | "puresoul_out_of_stock"
  | "puresoul_review"
  | "puresoul_missing"
  | "puresoul_different"
  | "puresoul_price_diff";

export const OPERATIONS_FILTER_VALUES: readonly OperationsFilter[] = [
  "all",
  "new",
  "needs_image",
  "needs_review",
  "ready",
  "high_priority",
  "has_tasks",
  "shopify_missing",
  "shopify_different",
  "ticktick_synced",
  "puresoul_out_of_stock",
  "puresoul_review",
  "puresoul_missing",
  "puresoul_different",
  "puresoul_price_diff",
];

export const OPERATIONS_FILTER_LABELS: Record<OperationsFilter, string> = {
  all: "الكل",
  new: "المنتجات الجديدة",
  needs_image: "يحتاج صورة",
  needs_review: "يحتاج مراجعة",
  ready: "جاهز",
  high_priority: "أولوية عالية",
  has_tasks: "لديه مهام",
  shopify_missing: "Shopify: غير موجود",
  shopify_different: "Shopify: مختلف",
  ticktick_synced: "مُزامَن مع TickTick",
  puresoul_out_of_stock: "PureSoul: نافد",
  puresoul_review: "PureSoul: مراجعة",
  puresoul_missing: "PureSoul: غير موجود",
  puresoul_different: "PureSoul: مختلف",
  puresoul_price_diff: "PureSoul: فرق سعر",
};

export const OPERATIONS_PAGE_SIZE = 24;

/** Build a client-safe list item from one product + its engine outputs. */
export function toListItem(
  product: OperationsProduct,
  readiness: ProductReadiness,
  tasks: readonly OperationTask[],
  platforms: readonly PlatformStatus[],
): OperationsListItem {
  return {
    id: product.id,
    sku: product.sku,
    barcode: product.barcode,
    nameAr: product.nameAr,
    nameEn: product.nameEn,
    price: product.price,
    imageUrl: product.imageUrl,
    readinessPercent: readiness.percent,
    readinessStatus: readiness.status,
    reasons: readiness.reasons.map((r) => r.message),
    isNew: readiness.isNew,
    needsImage: readiness.checks.some((c) => c.code === "image" && !c.passed),
    needsReview: readiness.status === "needs_review",
    taskCount: tasks.length,
    tasks: [...tasks],
    platforms: [...platforms],
  };
}

function shopifyStatus(item: OperationsListItem): PlatformStatusValue | null {
  return item.platforms.find((p) => p.platform === "shopify")?.status ?? null;
}

// PureSoul filters read the snapshot-derived state (Phase UI.9.3) — a single
// source of truth. "different" == price_different this phase (price is the only
// field comparePureSeoul compares; name-diff is not reliably available).
function isPureSoulState(item: OperationsListItem, state: PureSoulState): boolean {
  return item.puresoulState === state;
}

/** Apply a single filter (pure). Unknown filter → no narrowing. */
export function filterOperations(
  items: readonly OperationsListItem[],
  filter: OperationsFilter,
): OperationsListItem[] {
  switch (filter) {
    case "new":
      return items.filter((i) => i.isNew);
    case "needs_image":
      return items.filter((i) => i.needsImage);
    case "needs_review":
      return items.filter((i) => i.needsReview);
    case "ready":
      return items.filter((i) => i.readinessStatus === "ready");
    case "high_priority":
      return items.filter((i) => i.tasks.some((t) => t.priority === "high"));
    case "has_tasks":
      return items.filter((i) => i.taskCount > 0);
    case "ticktick_synced":
      return items.filter((i) => (i.ticktickSyncedCount ?? 0) > 0);
    case "shopify_missing":
      return items.filter((i) => shopifyStatus(i) === "missing");
    case "shopify_different":
      return items.filter((i) => shopifyStatus(i) === "different");
    case "puresoul_out_of_stock":
      return items.filter((i) => isPureSoulState(i, "out_of_stock"));
    case "puresoul_review":
      return items.filter((i) => isPureSoulState(i, "review"));
    case "puresoul_missing":
      return items.filter((i) => isPureSoulState(i, "missing"));
    case "puresoul_different": // price is the only compared field this phase
    case "puresoul_price_diff":
      return items.filter((i) => isPureSoulState(i, "price_different"));
    case "all":
    default:
      return [...items];
  }
}

/** Search by SKU / barcode / Arabic name / English name (case-insensitive). */
export function searchOperations(
  items: readonly OperationsListItem[],
  query: string,
): OperationsListItem[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...items];
  return items.filter((i) =>
    [(i.sku ?? ""), (i.barcode ?? ""), (i.nameAr ?? ""), (i.nameEn ?? "")]
      .some((v) => v.toLowerCase().includes(q)),
  );
}

export interface OperationsPage {
  items: OperationsListItem[];
  page: number;
  totalPages: number;
  total: number;
  startIndex: number;
}

/** Clamp to a real page and slice — never renders thousands of rows at once. */
export function paginateOperations(
  items: readonly OperationsListItem[],
  requestedPage: number,
  pageSize: number = OPERATIONS_PAGE_SIZE,
): OperationsPage {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, Math.floor(requestedPage) || 1), totalPages);
  const startIndex = (page - 1) * pageSize;
  return { items: items.slice(startIndex, startIndex + pageSize), page, totalPages, total, startIndex };
}

export interface OperationsControls {
  query: string;
  filter: OperationsFilter;
  page: number;
}

/** Validate raw URL search params into safe controls. */
export function parseOperationsControls(
  params: Record<string, string | string[] | undefined> | null | undefined,
): OperationsControls {
  const one = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? "") : (v ?? ""));
  const rawFilter = one(params?.filter);
  const filter = (OPERATIONS_FILTER_VALUES as readonly string[]).includes(rawFilter)
    ? (rawFilter as OperationsFilter)
    : "all";
  const page = Math.max(1, Number.parseInt(one(params?.page), 10) || 1);
  return { query: one(params?.query).slice(0, 80), filter, page };
}

/** Full server-side pipeline: filter → search → paginate. */
export function selectOperationsPage(
  items: readonly OperationsListItem[],
  controls: OperationsControls,
): OperationsPage {
  return paginateOperations(searchOperations(filterOperations(items, controls.filter), controls.query), controls.page);
}
