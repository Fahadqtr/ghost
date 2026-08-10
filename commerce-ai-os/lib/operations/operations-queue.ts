// Malikas V2 — Commerce Intelligence CI.2: Unified Operations Queue (PURE).
//
// One cross-platform issue list for /v2/operations, built ONLY from the already-
// loaded OperationsListItem[] via CI.1's buildPlatformMatrixItem — no readers, no
// queries, no snapshot logic, no platform-specific branching. Severity/reason/
// queue derive from the normalized MatrixState ALONE.
//
// Honesty invariants (inherited from the matrix): present/unknown are NOT issues;
// stale is a freshness modifier, never a state, and never promotes to an issue;
// no platform enum is ever re-interpreted here.

import type { OperationsListItem } from "./dashboard-view.ts";
import { buildPlatformMatrixItem, type MatrixState } from "./platform-matrix.ts";
import { PLATFORM_TYPES } from "./platforms/platform-status.ts";
import type { PlatformType } from "./shared/models.ts";
import { OPERATIONS_PAGE_SIZE } from "./dashboard-view.ts";

export type IssueSeverity = "high" | "medium" | "low";
export type IssueReason = "not_listed" | "needs_review" | "drifted" | "staged_not_live";
export type QueueKey = "all" | "missing" | "review" | "different" | "ready";

export interface CrossPlatformIssue {
  productId: string;
  sku: string | null;
  barcode: string | null;
  nameAr: string | null;
  nameEn: string | null;
  imageUrl: string | null;
  platform: PlatformType;
  label: string;
  state: MatrixState;
  severity: IssueSeverity;
  reason: IssueReason;
  flags: string[];
  capturedAt: string | null;
  stale: boolean;
}

export interface QueueCounts {
  missing: number;
  review: number;
  different: number;
  ready: number;
  total: number;
}

export interface OperationsQueues {
  all: CrossPlatformIssue[];
  missing: CrossPlatformIssue[];
  review: CrossPlatformIssue[];
  different: CrossPlatformIssue[];
  ready: CrossPlatformIssue[];
  counts: QueueCounts;
  /** true when the defensive cap dropped some issues (surfaced, never silent) */
  capped: boolean;
}

/** Defensive upper bound on emitted issues (products are already read-capped). */
export const MAX_QUEUE_ISSUES = 2000;

/** The ONLY mapping — MatrixState → (severity, reason, queue). Actionable states
 *  only; present/unknown are absent ⇒ never an issue. No platform logic. */
const ISSUE_RULES: Partial<Record<MatrixState, { severity: IssueSeverity; reason: IssueReason; queue: Exclude<QueueKey, "all"> }>> = {
  missing: { severity: "high", reason: "not_listed", queue: "missing" },
  review: { severity: "high", reason: "needs_review", queue: "review" },
  different: { severity: "medium", reason: "drifted", queue: "different" },
  ready: { severity: "low", reason: "staged_not_live", queue: "ready" },
};

const SEVERITY_RANK: Record<IssueSeverity, number> = { high: 0, medium: 1, low: 2 };
const PLATFORM_RANK: Record<string, number> = Object.fromEntries(PLATFORM_TYPES.map((p, i) => [p, i]));

/**
 * Flatten every product's matrix cells into cross-platform issues. present/unknown
 * cells yield nothing. Bounded by MAX_QUEUE_ISSUES (extra dropped → `capped`).
 * Product identity/display comes from the item; state/platform from the cell.
 */
export function buildCrossPlatformIssues(items: readonly OperationsListItem[]): { issues: CrossPlatformIssue[]; capped: boolean } {
  const issues: CrossPlatformIssue[] = [];
  let capped = false;
  for (const item of items ?? []) {
    const matrix = buildPlatformMatrixItem(item);
    for (const cell of matrix.cells) {
      const rule = ISSUE_RULES[cell.state];
      if (!rule) continue; // present / unknown → not an issue
      if (issues.length >= MAX_QUEUE_ISSUES) {
        capped = true;
        return { issues, capped };
      }
      issues.push({
        productId: item.id,
        sku: item.sku,
        barcode: item.barcode,
        nameAr: item.nameAr,
        nameEn: item.nameEn,
        imageUrl: item.imageUrl,
        platform: cell.platform,
        label: cell.label,
        state: cell.state,
        severity: rule.severity,
        reason: rule.reason,
        flags: cell.flags,
        capturedAt: cell.capturedAt,
        stale: cell.stale,
      });
    }
  }
  return { issues, capped };
}

/**
 * Deterministic order: severity (high→low) → freshness (stale first, then oldest
 * capturedAt; nulls sort last but stable) → platform (PLATFORM_TYPES order) →
 * sku → productId. Sorts a COPY; input is never mutated.
 */
export function sortIssues(issues: readonly CrossPlatformIssue[]): CrossPlatformIssue[] {
  return [...(issues ?? [])].sort((a, b) => {
    const sev = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (sev !== 0) return sev;
    if (a.stale !== b.stale) return a.stale ? -1 : 1; // stale first
    // oldest capturedAt first; nulls last
    const at = (a.capturedAt ?? "￿").localeCompare(b.capturedAt ?? "￿");
    if (at !== 0) return at;
    const plat = (PLATFORM_RANK[a.platform] ?? 99) - (PLATFORM_RANK[b.platform] ?? 99);
    if (plat !== 0) return plat;
    const sku = (a.sku ?? "").localeCompare(b.sku ?? "");
    if (sku !== 0) return sku;
    return a.productId.localeCompare(b.productId);
  });
}

/** Group sorted issues into the four queues + a severity-sorted `all` + counts. */
export function groupOperationsQueues(issues: readonly CrossPlatformIssue[], capped = false): OperationsQueues {
  const all = sortIssues(issues);
  const missing = all.filter((i) => i.reason === "not_listed");
  const review = all.filter((i) => i.reason === "needs_review");
  const different = all.filter((i) => i.reason === "drifted");
  const ready = all.filter((i) => i.reason === "staged_not_live");
  return {
    all,
    missing,
    review,
    different,
    ready,
    counts: { missing: missing.length, review: review.length, different: different.length, ready: ready.length, total: all.length },
    capped,
  };
}

/** One-shot: items → grouped queues (build + group). Pure, zero reads. */
export function buildOperationsQueues(items: readonly OperationsListItem[]): OperationsQueues {
  const { issues, capped } = buildCrossPlatformIssues(items);
  return groupOperationsQueues(issues, capped);
}

/** Pick the list for a queue key (`all` = the severity-sorted union). */
export function selectQueue(queues: OperationsQueues, key: QueueKey): CrossPlatformIssue[] {
  switch (key) {
    case "missing":
      return queues.missing;
    case "review":
      return queues.review;
    case "different":
      return queues.different;
    case "ready":
      return queues.ready;
    default:
      return queues.all;
  }
}

export interface IssuePage {
  items: CrossPlatformIssue[];
  page: number;
  totalPages: number;
  total: number;
  startIndex: number;
}

/** Clamp + slice — only the current page ever crosses to the browser. */
export function paginateIssues(
  issues: readonly CrossPlatformIssue[],
  requestedPage: number,
  pageSize: number = OPERATIONS_PAGE_SIZE,
): IssuePage {
  const list = Array.isArray(issues) ? issues : [];
  const total = list.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, Math.floor(requestedPage) || 1), totalPages);
  const startIndex = (page - 1) * pageSize;
  return { items: list.slice(startIndex, startIndex + pageSize), page, totalPages, total, startIndex };
}

export const QUEUE_VALUES: readonly QueueKey[] = ["all", "missing", "review", "different", "ready"];

export interface QueueControl {
  queue: QueueKey;
  page: number;
}

/** Parse the `queue` + `qpage` GET params (independent of the product-list
 *  controls, so existing operations filters stay untouched). */
export function parseQueueControl(params: Record<string, string | string[] | undefined> | null | undefined): QueueControl {
  const one = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? "") : (v ?? ""));
  const raw = one(params?.queue);
  const queue = (QUEUE_VALUES as readonly string[]).includes(raw) ? (raw as QueueKey) : "all";
  const page = Math.max(1, Number.parseInt(one(params?.qpage), 10) || 1);
  return { queue, page };
}

// ── fixed Arabic labels (UI holds no platform/severity logic) ────────────────

export const QUEUE_LABELS: Record<QueueKey, string> = {
  all: "الكل",
  missing: "غير موجود",
  review: "يحتاج مراجعة",
  different: "مختلف",
  ready: "جاهز/مربوط",
};

export const ISSUE_REASON_LABELS: Record<IssueReason, string> = {
  not_listed: "غير مُدرج على المنصة",
  needs_review: "يحتاج مراجعة يدوية",
  drifted: "يختلف عن ماليكاس",
  staged_not_live: "مُجهّز ولم يُنشر بعد",
};

export const ISSUE_SEVERITY_LABELS: Record<IssueSeverity, string> = {
  high: "عالية",
  medium: "متوسطة",
  low: "منخفضة",
};
