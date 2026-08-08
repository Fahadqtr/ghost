// Malikas V2 — TickTick mapper (Phase UI.7.5). PURE: models in, payload out. No
// database, no fetch, no env, no clock, no randomness.
//
// This is the ONLY place Malikas data is shaped into a TickTick task, and it
// contains ZERO business rules: title / reason / platform / priority all come
// straight from the engine-computed OperationTask — the mapper never decides
// them. It only formats + routes, and stamps a deterministic marker so the same
// Malikas task always maps to the same TickTick task (no duplicates).

import type { OperationTask, TaskPriority } from "@/lib/operations/shared/models";
import type { TaskViewItem } from "@/lib/operations/tasks-view";
import type {
  TickTickPriority,
  TickTickProjectKey,
  TickTickProjectMap,
  TickTickTaskPayload,
} from "./types";

/** Canonical Malikas domain for the product deep-link (overridable by the
 *  caller, e.g. from an env base). */
export const DEFAULT_APP_URL = "https://app.malikasuniverse.com";

// ── deterministic marker (identity across syncs) ─────────────────────────────

const MARKER_RE = /\[\[malikas:([^\]\n]+)\]\]/;

/** The safe, unique marker embedded in a task's content. Uses the OperationTask
 *  id verbatim (e.g. `needs_image:p1`, `publish_platform:shopify:p1`). */
export function buildMarker(operationTaskId: string): string {
  return `[[malikas:${operationTaskId}]]`;
}

/** Extract the Malikas OperationTask id from a task's content, or null when the
 *  task is NOT Malikas-owned (so foreign/manual tasks are never touched). */
export function parseMarker(content: string | null | undefined): string | null {
  if (typeof content !== "string") return null;
  const m = MARKER_RE.exec(content);
  return m ? m[1]! : null;
}

// ── priority (mapped ONLY from OperationTask.priority — never computed) ───────

const PRIORITY_MAP: Record<TaskPriority, TickTickPriority> = { high: 5, medium: 3, low: 1 };

export function priorityToTickTick(priority: TaskPriority): TickTickPriority {
  return PRIORITY_MAP[priority] ?? 1;
}

// ── project routing (which list a task belongs to) ───────────────────────────

/** Route a task to a logical list by its TYPE/PLATFORM (both from the engine).
 *  Publishing/review tasks route by platform; everything else by type. */
export function projectKeyFor(task: OperationTask): TickTickProjectKey {
  if (task.platform) {
    switch (task.platform) {
      case "shopify": return "shopify";
      case "puresoul": return "puresoul";
      case "talabat": return "talabat";
      case "rafeeq": return "rafeeq";
    }
  }
  switch (task.type) {
    case "needs_image": return "photos";
    case "new_product": return "new_products";
    case "needs_review":
    case "needs_data":
      return "review";
    case "platform_review":
    case "publish_platform":
      return "review"; // no platform present → default to the review list
    default:
      return "review";
  }
}

/** Resolve a project key to a configured TickTick project id (or undefined when
 *  the owner has not configured that list — the adapter then SKIPS the task
 *  rather than dropping it into the Inbox). */
export function resolveProjectId(key: TickTickProjectKey, map: TickTickProjectMap): string | undefined {
  const id = map[key];
  return typeof id === "string" && id.trim() !== "" ? id : undefined;
}

// ── content / title formatting ───────────────────────────────────────────────

export function productUrl(productId: string, baseUrl: string = DEFAULT_APP_URL): string {
  const base = (baseUrl || DEFAULT_APP_URL).replace(/\/+$/, "");
  return `${base}/v2/catalog/${encodeURIComponent(productId)}`;
}

const PLATFORM_AR: Record<string, string> = {
  shopify: "Shopify",
  puresoul: "PureSoul",
  talabat: "Talabat",
  rafeeq: "Rafeeq",
};

function label(item: TaskViewItem): string {
  return (item.sku ?? "").trim() || (item.nameAr ?? "").trim() || (item.nameEn ?? "").trim() || item.productId;
}

/** Task title, e.g. «إضافة صورة — MK2239». The title text is the engine's; only
 *  the product label is appended. */
export function buildTitle(item: TaskViewItem): string {
  const t = (item.task.title ?? "").trim() || "مهمة";
  return `${t} — ${label(item)}`;
}

/** Task description body: the Malikas fields + reason + platform + deep-link,
 *  then the deterministic marker on its own line. No business logic. */
export function buildContent(item: TaskViewItem, baseUrl: string = DEFAULT_APP_URL): string {
  const t = item.task;
  const lines = [
    `SKU: ${item.sku ?? "—"}`,
    `الباركود: ${item.barcode ?? "—"}`,
    `الاسم (عربي): ${item.nameAr ?? "—"}`,
    `الاسم (إنجليزي): ${item.nameEn ?? "—"}`,
    `السبب: ${(t.reason ?? "").trim() || "—"}`,
    ...(t.platform ? [`المنصة: ${PLATFORM_AR[t.platform] ?? t.platform}`] : []),
    `المنتج في ماليكاس: ${productUrl(item.productId, baseUrl)}`,
    "",
    buildMarker(t.id),
  ];
  return lines.join("\n");
}

/** A short, plain-text summary of a task's content body for previews: the
 *  deterministic marker line is stripped and the text is clamped. PURE — used by
 *  the dry-run planner and the /v2/tasks preview panel so both show the same
 *  human-readable summary of what WOULD be written. */
export function summarizeContent(content: string | null | undefined, max = 200): string {
  const text = typeof content === "string" ? content : "";
  return text
    .split("\n")
    .filter((line) => !line.includes("[[malikas:"))
    .join("\n")
    .replace(/\n{2,}/g, "\n")
    .trim()
    .slice(0, max);
}

// ── full payload ─────────────────────────────────────────────────────────────

export interface MappedTask {
  /** resolved TickTick project id, or undefined when the list is unconfigured */
  projectId: string | undefined;
  projectKey: TickTickProjectKey;
  payload: TickTickTaskPayload;
}

/** Map one Malikas task-view item into a TickTick payload (create-shaped; the
 *  adapter adds the id for updates). PURE. */
export function mapTaskToPayload(
  item: TaskViewItem,
  opts: { projectMap: TickTickProjectMap; baseUrl?: string },
): MappedTask {
  const key = projectKeyFor(item.task);
  const projectId = resolveProjectId(key, opts.projectMap);
  return {
    projectId,
    projectKey: key,
    payload: {
      ...(projectId ? { projectId } : {}),
      title: buildTitle(item),
      content: buildContent(item, opts.baseUrl),
      priority: priorityToTickTick(item.task.priority),
    },
  };
}
