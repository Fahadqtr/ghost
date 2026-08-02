// Pure view layer for the Order Operations console (Phase 2B.3B).
//
// DB-free, network-free, framework-free: no "server-only", no Supabase/Next
// imports, no fetch, no Date.now()/argless new Date(), no `any`. Only TYPES are
// imported from Phase 2B.1 (erased at runtime → node:test-importable). It parses
// search params into safe filters, filters/sorts the already-PII-safe OrderOpsRow
// list in memory, summarizes the visible rows, and maps codes to fixed Arabic
// labels (never reflecting unknown/raw text).

import type {
  OrderOpsChannel,
  OrderOpsRow,
  OrderOpsSource,
  OrderOpsStatus,
  ReconciliationSignal,
  SignalKind,
  SignalState,
} from "./order-ops-compute";

// ── Filters ──────────────────────────────────────────────────────────────────

export type SourceFilter = "all" | OrderOpsSource;
export type ChannelFilter = "all" | OrderOpsChannel;
export type StatusFilter = "all" | OrderOpsStatus;
export type AttentionFilter = "all" | "flagged" | "manual_review" | "unmatched" | "blocked" | "malformed" | "channel_mismatch";

export interface OrderOpsViewFilters {
  source: SourceFilter;
  channel: ChannelFilter;
  status: StatusFilter;
  attention: AttentionFilter;
  query: string;
}

const SOURCE_VALUES: readonly SourceFilter[] = ["all", "talabat", "shopify"];
const CHANNEL_VALUES: readonly ChannelFilter[] = ["all", "talabat", "shopify", "unknown"];
const STATUS_VALUES: readonly StatusFilter[] = ["all", "pending", "processed", "baseline", "manual_review", "failed", "blocked", "unknown"];
const ATTENTION_VALUES: readonly AttentionFilter[] = ["all", "flagged", "manual_review", "unmatched", "blocked", "malformed", "channel_mismatch"];

const MAX_QUERY_LENGTH = 80;

export const DEFAULT_FILTERS: OrderOpsViewFilters = {
  source: "all",
  channel: "all",
  status: "all",
  attention: "all",
  query: "",
};

export type OrderOpsSearchParams = Record<string, string | string[] | undefined> | null | undefined;

/** Take the single usable string from a search param (first string of an array). */
function pickParam(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    for (const el of v) if (typeof el === "string") return el; // first string only
  }
  return null; // never coerce non-strings
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  const s = pickParam(v);
  return s !== null && (allowed as readonly string[]).includes(s) ? (s as T) : fallback;
}

/** Parse untrusted search params into safe filters. Unknown values → "all". */
export function parseOrderOpsViewFilters(params: OrderOpsSearchParams): OrderOpsViewFilters {
  const p: Record<string, unknown> = params && typeof params === "object" ? params : {};
  const rawQuery = pickParam(p.query);
  return {
    source: oneOf(p.source, SOURCE_VALUES, "all"),
    channel: oneOf(p.channel, CHANNEL_VALUES, "all"),
    status: oneOf(p.status, STATUS_VALUES, "all"),
    attention: oneOf(p.attention, ATTENTION_VALUES, "all"),
    query: rawQuery === null ? "" : rawQuery.trim().slice(0, MAX_QUERY_LENGTH),
  };
}

// ── Signal helpers ───────────────────────────────────────────────────────────

function signalState(row: OrderOpsRow, kind: SignalKind): SignalState | null {
  const s = Array.isArray(row.signals) ? row.signals.find((x) => x.kind === kind) : undefined;
  return s ? s.state : null;
}
function isSignalFlagged(row: OrderOpsRow, kind: SignalKind): boolean {
  return signalState(row, kind) === "flagged";
}
function hasAnyFlagged(row: OrderOpsRow): boolean {
  return Array.isArray(row.signals) && row.signals.some((s) => s.state === "flagged");
}
/** Malformed identity: the persisted id was missing/malformed (Phase 2B.1). */
export function isMalformedIdentity(row: OrderOpsRow): boolean {
  return row.sourceOrderId === "";
}
/** Signals worth surfacing in the UI: flagged (problem) or unknown (unresolved). */
export function visibleSignals(row: OrderOpsRow): ReconciliationSignal[] {
  return Array.isArray(row.signals) ? row.signals.filter((s) => s.state === "flagged" || s.state === "unknown") : [];
}

function matchesAttention(row: OrderOpsRow, attention: AttentionFilter): boolean {
  switch (attention) {
    case "all":
      return true;
    case "flagged":
      return hasAnyFlagged(row);
    case "manual_review":
      return isSignalFlagged(row, "manual_review") || row.status === "manual_review";
    case "unmatched":
      return isSignalFlagged(row, "unmatched");
    case "blocked":
      return isSignalFlagged(row, "blocked") || row.status === "blocked";
    case "malformed":
      return isSignalFlagged(row, "malformed_result");
    case "channel_mismatch":
      return isSignalFlagged(row, "channel_attribution_mismatch");
    default:
      return true;
  }
}

// ── Filtering (in-memory only) ───────────────────────────────────────────────

export function filterOrderOpsRows(rows: OrderOpsRow[], filters: OrderOpsViewFilters): OrderOpsRow[] {
  const q = filters.query.trim().toLowerCase();
  return (Array.isArray(rows) ? rows : []).filter((r) => {
    if (filters.source !== "all" && r.source !== filters.source) return false;
    if (filters.channel !== "all" && r.channel !== filters.channel) return false;
    if (filters.status !== "all" && r.status !== filters.status) return false;
    if (!matchesAttention(r, filters.attention)) return false;
    if (q.length > 0) {
      // Read identity fields with a runtime type guard only — NEVER trigger value
      // coercion (no String(), no .toString(), no Symbol.toPrimitive). A
      // non-string (e.g. a hostile object) is treated as an empty string, so a
      // malformed value can never match a query through coercion.
      const code = typeof r.displayOrderCode === "string" ? r.displayOrderCode.toLowerCase() : "";
      const id = typeof r.sourceOrderId === "string" ? r.sourceOrderId.toLowerCase() : "";
      // search ONLY the code and id — never reason or any raw data
      if (!code.includes(q) && !id.includes(q)) return false;
    }
    return true;
  });
}

// ── Sorting (deterministic, non-mutating) ────────────────────────────────────

/** Parse a valid ISO-ish string to ms; null for non-string/invalid. No now(). */
function validTime(v: string | null): number | null {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}
function rowTime(row: OrderOpsRow): number | null {
  return validTime(row.createdAt) ?? validTime(row.processedAt);
}

export function sortOrderOpsRows(rows: OrderOpsRow[]): OrderOpsRow[] {
  return [...(Array.isArray(rows) ? rows : [])].sort((a, b) => {
    const ta = rowTime(a);
    const tb = rowTime(b);
    if (ta !== null && tb !== null) {
      if (ta !== tb) return tb - ta; // newest first
    } else if (ta !== null) {
      return -1; // valid dates before missing/invalid
    } else if (tb !== null) {
      return 1;
    }
    return (
      a.source.localeCompare(b.source) ||
      a.sourceOrderId.localeCompare(b.sourceOrderId) ||
      a.displayOrderCode.localeCompare(b.displayOrderCode)
    );
  });
}

// ── Visible-rows summary ─────────────────────────────────────────────────────

export interface OrderOpsViewSummary {
  visibleTotal: number;
  needsAttention: number;
  manualReview: number;
  failed: number;
  blocked: number;
  talabat: number;
  shopify: number;
  unknownChannel: number;
}

export function summarizeVisibleRows(rows: OrderOpsRow[]): OrderOpsViewSummary {
  const list = Array.isArray(rows) ? rows : [];
  return {
    visibleTotal: list.length,
    needsAttention: list.filter(hasAnyFlagged).length, // each row counted once
    manualReview: list.filter((r) => r.status === "manual_review").length,
    failed: list.filter((r) => r.status === "failed").length,
    blocked: list.filter((r) => r.status === "blocked").length,
    talabat: list.filter((r) => r.source === "talabat").length,
    shopify: list.filter((r) => r.source === "shopify").length,
    unknownChannel: list.filter((r) => r.channel === "unknown").length,
  };
}

// ── Fixed Arabic labels (never reflect unknown/raw text) ─────────────────────

const UNKNOWN_LABEL = "غير معروف";
const UNKNOWN_REASON_LABEL = "سبب غير معروف";

const SOURCE_LABELS: Record<OrderOpsSource, string> = { talabat: "Talabat", shopify: "Shopify" };
const CHANNEL_LABELS: Record<OrderOpsChannel, string> = { talabat: "Talabat", shopify: "Shopify", unknown: "قناة غير محددة" };
const STATUS_LABELS: Record<OrderOpsStatus, string> = {
  pending: "قيد الانتظار",
  processed: "تمت المعالجة",
  baseline: "خط أساس",
  manual_review: "مراجعة يدوية",
  failed: "فشل",
  blocked: "محظور",
  unknown: "غير معروف",
};
const SIGNAL_KIND_LABELS: Record<SignalKind, string> = {
  manual_review: "مراجعة يدوية",
  unmatched: "صنف غير مطابق",
  possible_duplicate: "تكرار محتمل",
  under_deduction: "نقص خصم محتمل",
  void_or_refunded: "ملغي/مسترجع",
  blocked: "محظور",
  malformed_result: "نتيجة غير صالحة",
  channel_attribution_mismatch: "تعارض في القناة",
};
const SIGNAL_STATE_LABELS: Record<SignalState, string> = { flagged: "مرصود", clear: "سليم", unknown: "غير محسوم" };

const REASON_LABELS: Record<string, string> = {
  // Talabat classified reasons
  auto_deduct_misconfigured: "إعداد الخصم الآلي غير صحيح",
  event_not_allowed: "حدث غير مسموح",
  talabat_channel_unresolved: "تعذّر تحديد قناة Talabat",
  context_unavailable: "سياق المعالجة غير متاح",
  weak_order_identity: "هوية طلب ضعيفة",
  empty_order: "طلب فارغ",
  invalid_quantity: "كمية غير صالحة",
  inactive_mapping: "ربط غير مُفعّل",
  ambiguous_match: "تطابق غامض",
  conflicting_identifiers: "معرّفات متعارضة",
  title_only_match: "تطابق بالاسم فقط",
  unmatched: "صنف غير مطابق",
  inventory_inconsistent: "عدم اتساق المخزون",
  invalid_plan: "خطة خصم غير صالحة",
  insufficient_stock: "مخزون غير كافٍ",
  duplicate_order: "طلب مكرر",
  rpc_failed: "فشل استدعاء المعالجة",
  schedule_failed: "فشل جدولة المعالجة",
  processing_failed: "فشل المعالجة",
  manual_review: "مراجعة يدوية",
  // Shopify classified reasons
  baseline_recorded: "سُجّل كخط أساس",
  already_processed: "سبقت معالجته",
  unmatched_order: "طلب غير مطابق",
  orders_truncated: "طلبات غير مكتملة القراءة",
  line_items_truncated: "أصناف غير مكتملة القراءة",
  migration_required: "يلزم تحديث قاعدة البيانات",
  db_error: "خطأ قاعدة بيانات مؤقت",
  unknown_response: "استجابة غير متوقعة",
  unknown_reason: "سبب غير معروف",
};

/**
 * Prototype-safe fixed-label lookup. Returns the mapped label ONLY when `key` is
 * a string that is an OWN, enumerable-or-not property of `labels` whose value is
 * itself a string. Inherited keys (`__proto__`, `constructor`, `toString`,
 * `valueOf`, `hasOwnProperty`, …) and any non-string key or value fall closed to
 * `fallback` — so an unknown or hostile key can never surface an inherited
 * function/object or reflect its own text.
 */
function fixedLabel<T extends object>(labels: T, key: unknown, fallback: string): string {
  if (typeof key !== "string") return fallback;
  if (!Object.hasOwn(labels, key)) return fallback;
  const value = (labels as Record<string, unknown>)[key];
  return typeof value === "string" ? value : fallback;
}

export function getSourceLabel(source: OrderOpsSource): string {
  return fixedLabel(SOURCE_LABELS, source, UNKNOWN_LABEL);
}
export function getChannelLabel(channel: OrderOpsChannel): string {
  return fixedLabel(CHANNEL_LABELS, channel, UNKNOWN_LABEL);
}
export function getStatusLabel(status: OrderOpsStatus): string {
  return fixedLabel(STATUS_LABELS, status, UNKNOWN_LABEL);
}
export function getSignalKindLabel(kind: SignalKind): string {
  return fixedLabel(SIGNAL_KIND_LABELS, kind, UNKNOWN_LABEL);
}
export function getSignalStateLabel(state: SignalState): string {
  return fixedLabel(SIGNAL_STATE_LABELS, state, UNKNOWN_LABEL);
}
/** null reason → null (omit). Known → fixed label. Unknown/inherited → generic. */
export function getReasonLabel(reasonCode: string | null): string | null {
  if (reasonCode === null) return null;
  return fixedLabel(REASON_LABELS, reasonCode, UNKNOWN_REASON_LABEL);
}

// ── Date formatting (Asia/Qatar; safe) ───────────────────────────────────────

export function formatOrderOpsDate(value: string | null): string {
  if (typeof value !== "string") return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  try {
    return d.toLocaleString("ar-QA", {
      timeZone: "Asia/Qatar",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

// ── Filter option lists (for the <form> selects) ─────────────────────────────

export interface FilterOption<T extends string> {
  value: T;
  label: string;
}
export const SOURCE_OPTIONS: readonly FilterOption<SourceFilter>[] = [
  { value: "all", label: "كل المصادر" },
  { value: "talabat", label: "Talabat" },
  { value: "shopify", label: "Shopify" },
];
export const CHANNEL_OPTIONS: readonly FilterOption<ChannelFilter>[] = [
  { value: "all", label: "كل القنوات" },
  { value: "talabat", label: "Talabat" },
  { value: "shopify", label: "Shopify" },
  { value: "unknown", label: "قناة غير محددة" },
];
export const STATUS_OPTIONS: readonly FilterOption<StatusFilter>[] = [
  { value: "all", label: "كل الحالات" },
  { value: "pending", label: "قيد الانتظار" },
  { value: "processed", label: "تمت المعالجة" },
  { value: "baseline", label: "خط أساس" },
  { value: "manual_review", label: "مراجعة يدوية" },
  { value: "failed", label: "فشل" },
  { value: "blocked", label: "محظور" },
  { value: "unknown", label: "غير معروف" },
];
export const ATTENTION_OPTIONS: readonly FilterOption<AttentionFilter>[] = [
  { value: "all", label: "الكل" },
  { value: "flagged", label: "تحتاج متابعة" },
  { value: "manual_review", label: "مراجعة يدوية" },
  { value: "unmatched", label: "غير مطابق" },
  { value: "blocked", label: "محظور" },
  { value: "malformed", label: "نتيجة غير صالحة" },
  { value: "channel_mismatch", label: "تعارض قناة" },
];
