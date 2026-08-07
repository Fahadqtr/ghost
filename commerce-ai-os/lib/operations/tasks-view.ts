// Malikas V2 Operations — Smart Tasks view layer (Phase UI.7.3).
//
// PURE: flattens the engine-computed tasks (already produced by
// lib/operations/tasks/task-engine.ts) joined to their product's display
// fields, then filters / searches / paginates. NO business logic is
// re-implemented here — tasks come straight from OperationsListItem.tasks.
// No database, no fetch, no clock.

import type { OperationsListItem } from "./dashboard-view";
import type { OperationTask, PlatformType, TaskPriority, TaskType } from "./shared/models";

/** One task joined to its product's catalog-safe display fields. */
export interface TaskViewItem {
  task: OperationTask;
  productId: string;
  sku: string | null;
  barcode: string | null;
  nameAr: string | null;
  nameEn: string | null;
  imageUrl: string | null;
  readinessPercent: number;
}

/** Flatten the dashboard items into a flat task list (engine order preserved
 *  within each product; products in the order the reader returned them). The
 *  engine already sorts each product's tasks by priority. */
export function flattenTasks(items: readonly OperationsListItem[]): TaskViewItem[] {
  const out: TaskViewItem[] = [];
  for (const item of items) {
    for (const task of item.tasks) {
      out.push({
        task,
        productId: item.id,
        sku: item.sku,
        barcode: item.barcode,
        nameAr: item.nameAr,
        nameEn: item.nameEn,
        imageUrl: item.imageUrl,
        readinessPercent: item.readinessPercent,
      });
    }
  }
  return out;
}

const PRIORITY_RANK: Record<TaskPriority, number> = { high: 0, medium: 1, low: 2 };

/** Global stable ordering: priority (high→low), then type, then id. */
export function sortTaskViews(items: readonly TaskViewItem[]): TaskViewItem[] {
  return [...items].sort((a, b) => {
    const p = PRIORITY_RANK[a.task.priority] - PRIORITY_RANK[b.task.priority];
    if (p !== 0) return p;
    if (a.task.type !== b.task.type) return a.task.type < b.task.type ? -1 : 1;
    return a.task.id < b.task.id ? -1 : a.task.id > b.task.id ? 1 : 0;
  });
}

export type TaskFilter =
  | "all"
  | "high"
  | "medium"
  | "low"
  | "needs_image"
  | "needs_review"
  | "new_product"
  | "shopify"
  | "puresoul"
  | "talabat"
  | "rafeeq";

export const TASK_FILTER_VALUES: readonly TaskFilter[] = [
  "all", "high", "medium", "low", "needs_image", "needs_review", "new_product",
  "shopify", "puresoul", "talabat", "rafeeq",
];

export const TASK_FILTER_LABELS: Record<TaskFilter, string> = {
  all: "الكل",
  high: "عالية",
  medium: "متوسطة",
  low: "منخفضة",
  needs_image: "يحتاج صورة",
  needs_review: "يحتاج مراجعة",
  new_product: "منتج جديد",
  shopify: "Shopify",
  puresoul: "PureSoul",
  talabat: "Talabat",
  rafeeq: "Rafeeq",
};

const PLATFORM_FILTERS: Partial<Record<TaskFilter, PlatformType>> = {
  shopify: "shopify", puresoul: "puresoul", talabat: "talabat", rafeeq: "rafeeq",
};

/** Apply one filter. Platform filters match a task's platform ONLY — since a
 *  platform with no trusted snapshot is "unknown" and the engine never emits a
 *  task for it, an unknown platform can never appear here. */
export function filterTaskViews(items: readonly TaskViewItem[], filter: TaskFilter): TaskViewItem[] {
  if (filter === "all") return [...items];
  if (filter === "high" || filter === "medium" || filter === "low") {
    return items.filter((i) => i.task.priority === filter);
  }
  if (filter === "needs_image" || filter === "needs_review" || filter === "new_product") {
    const type: TaskType = filter;
    return items.filter((i) => i.task.type === type);
  }
  const platform = PLATFORM_FILTERS[filter];
  return platform ? items.filter((i) => i.task.platform === platform) : [...items];
}

export function searchTaskViews(items: readonly TaskViewItem[], query: string): TaskViewItem[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...items];
  return items.filter((i) =>
    [(i.sku ?? ""), (i.barcode ?? ""), (i.nameAr ?? ""), (i.nameEn ?? "")]
      .some((v) => v.toLowerCase().includes(q)),
  );
}

export interface TaskSummary {
  total: number;
  high: number;
  medium: number;
  low: number;
  needsImage: number;
  needsReview: number;
}

/** Counts over the WHOLE task set (not the current page). */
export function summarizeTasks(items: readonly TaskViewItem[]): TaskSummary {
  const s: TaskSummary = { total: 0, high: 0, medium: 0, low: 0, needsImage: 0, needsReview: 0 };
  for (const i of items) {
    s.total++;
    if (i.task.priority === "high") s.high++;
    else if (i.task.priority === "medium") s.medium++;
    else s.low++;
    if (i.task.type === "needs_image") s.needsImage++;
    if (i.task.type === "needs_review") s.needsReview++;
  }
  return s;
}

export const TASK_PAGE_SIZE = 24;

export interface TaskPage {
  items: TaskViewItem[];
  page: number;
  totalPages: number;
  total: number;
  startIndex: number;
}

export function paginateTaskViews(
  items: readonly TaskViewItem[],
  requestedPage: number,
  pageSize: number = TASK_PAGE_SIZE,
): TaskPage {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, Math.floor(requestedPage) || 1), totalPages);
  const startIndex = (page - 1) * pageSize;
  return { items: items.slice(startIndex, startIndex + pageSize), page, totalPages, total, startIndex };
}

export interface TaskControls {
  query: string;
  filter: TaskFilter;
  page: number;
}

export function parseTaskControls(
  params: Record<string, string | string[] | undefined> | null | undefined,
): TaskControls {
  const one = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? "") : (v ?? ""));
  const rawFilter = one(params?.filter);
  const filter = (TASK_FILTER_VALUES as readonly string[]).includes(rawFilter) ? (rawFilter as TaskFilter) : "all";
  const page = Math.max(1, Number.parseInt(one(params?.page), 10) || 1);
  return { query: one(params?.query).slice(0, 80), filter, page };
}

/** Full server-side pipeline: sort → filter → search → paginate. */
export function selectTaskPage(items: readonly TaskViewItem[], controls: TaskControls): TaskPage {
  return paginateTaskViews(
    searchTaskViews(filterTaskViews(sortTaskViews(items), controls.filter), controls.query),
    controls.page,
  );
}

/** Icon key per task type (rendered by the component; kept here so the mapping
 *  is testable and single-sourced). */
export const TASK_ICONS: Record<TaskType, string> = {
  needs_image: "image",
  needs_data: "data",
  needs_review: "review",
  new_product: "new",
  publish_platform: "publish",
  platform_review: "review",
};

/** The product-detail widget: the first N tasks + how many remain. */
export function productWidgetTasks(
  tasks: readonly OperationTask[],
  limit = 3,
): { shown: OperationTask[]; remaining: number } {
  const shown = tasks.slice(0, limit);
  return { shown, remaining: Math.max(0, tasks.length - shown.length) };
}
