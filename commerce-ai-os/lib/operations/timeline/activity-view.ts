// Malikas V2 Operations — Product Timeline view layer (Phase UI.7.4).
//
// PURE: maps a whitelisted DB row into the engine snapshot, and filters /
// searches / formats the engine-computed events for the UI. NO business logic
// is re-implemented here — events come straight from the activity engine. No
// database, no fetch, no "now" clock (dates are formatted by parsing the ISO
// string, never Date.now()), no randomness.

import type {
  ActivityEvent,
  ActivityEventKind,
  ActivityProductSnapshot,
} from "../shared/models";

// ── raw row → snapshot (defensive; blank/unknown cells become null) ──────────

/** Map a whitelisted `products` row into the timeline engine snapshot. Pure and
 *  defensive — non-string/blank cells become null, values are never coerced. */
export function mapActivityRow(row: Record<string, unknown>): ActivityProductSnapshot {
  const s = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
  return {
    id: typeof row.id === "string" ? row.id : "",
    sku: s(row.sku),
    barcode: s(row.barcode),
    nameAr: s(row.name_ar),
    nameEn: s(row.name_en),
    imageUrl: s(row.image_url),
    approval: s(row.approval),
    platformStatus: s(row.platform_status),
    createdAt: s(row.created_at),
    updatedAt: s(row.updated_at),
  };
}

// ── filters ──────────────────────────────────────────────────────────────────

export type ActivityFilter = "all" | "created" | "updated" | "approval" | "platform";

export const ACTIVITY_FILTER_VALUES: readonly ActivityFilter[] = [
  "all",
  "created",
  "updated",
  "approval",
  "platform",
];

export const ACTIVITY_FILTER_LABELS: Record<ActivityFilter, string> = {
  all: "الكل",
  created: "الإنشاء",
  updated: "التحديثات",
  approval: "الاعتماد",
  platform: "النشر",
};

/** Which filter bucket a kind belongs to. */
const KIND_FILTER: Record<ActivityEventKind, Exclude<ActivityFilter, "all">> = {
  created: "created",
  updated: "updated",
  approved: "approval",
  rejected: "approval",
  sent_to_ai: "approval",
  published: "platform",
};

/** Apply one filter (order-preserving; the engine already sorted the list). */
export function filterActivityEvents(
  events: readonly ActivityEvent[],
  filter: ActivityFilter,
): ActivityEvent[] {
  if (filter === "all") return [...events];
  return events.filter((e) => KIND_FILTER[e.kind] === filter);
}

/** Search the fixed Arabic title/description text (case-insensitive). A blank or
 *  whitespace-only query is a passthrough. */
export function searchActivityEvents(
  events: readonly ActivityEvent[],
  query: string,
): ActivityEvent[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...events];
  return events.filter((e) =>
    [e.title, e.description].some((v) => v.toLowerCase().includes(q)),
  );
}

// ── controls (validated GET state) ───────────────────────────────────────────

export interface ActivityControls {
  query: string;
  filter: ActivityFilter;
}

export function parseActivityControls(
  params: Record<string, string | string[] | undefined> | null | undefined,
): ActivityControls {
  const one = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? "") : (v ?? ""));
  const rawFilter = one(params?.filter);
  const filter = (ACTIVITY_FILTER_VALUES as readonly string[]).includes(rawFilter)
    ? (rawFilter as ActivityFilter)
    : "all";
  return { query: one(params?.query).slice(0, 80), filter };
}

/** Full server-side pipeline: filter → search (events arrive already sorted). */
export function selectActivityEvents(
  events: readonly ActivityEvent[],
  controls: ActivityControls,
): ActivityEvent[] {
  return searchActivityEvents(filterActivityEvents(events, controls.filter), controls.query);
}

// ── summary ──────────────────────────────────────────────────────────────────

export interface ActivitySummary {
  total: number;
  created: number;
  updated: number;
  approval: number;
  platform: number;
}

/** Counts over the WHOLE event set (never the filtered/searched subset). */
export function summarizeActivity(events: readonly ActivityEvent[]): ActivitySummary {
  const s: ActivitySummary = { total: 0, created: 0, updated: 0, approval: 0, platform: 0 };
  for (const e of events) {
    s.total++;
    s[KIND_FILTER[e.kind]]++;
  }
  return s;
}

// ── labels / icons / date formatting (single-sourced + testable) ─────────────

/** Fixed Arabic kind label (for a per-event chip). */
export const ACTIVITY_KIND_LABELS: Record<ActivityEventKind, string> = {
  created: "إنشاء",
  updated: "تحديث",
  approved: "اعتماد",
  rejected: "رفض",
  sent_to_ai: "ذكاء اصطناعي",
  published: "نشر",
};

/** Icon key per kind (the component turns it into a glyph). */
export const ACTIVITY_ICONS: Record<ActivityEventKind, string> = {
  created: "created",
  updated: "updated",
  approved: "approved",
  rejected: "rejected",
  sent_to_ai: "ai",
  published: "published",
};

const AR_MONTHS = [
  "يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو",
  "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر",
];

/**
 * Format an ISO timestamp as an absolute Arabic date ("7 أغسطس 2026"). PURE:
 * it parses the YYYY-MM-DD prefix by string ops only — no Date object and no
 * "now" — so the same input always yields the same output. Unknown/unparseable
 * input → "—".
 */
export function formatActivityDate(at: string | null): string {
  if (typeof at !== "string") return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(at.trim());
  if (m === null) return "—";
  const year = m[1];
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return "—";
  return `${day} ${AR_MONTHS[month - 1]} ${year}`;
}

// ── product-detail widget ────────────────────────────────────────────────────

/** The product-detail «النشاط» widget: the first N events + how many remain. */
export function activityWidgetEvents(
  events: readonly ActivityEvent[],
  limit = 3,
): { shown: ActivityEvent[]; remaining: number } {
  const shown = events.slice(0, limit);
  return { shown, remaining: Math.max(0, events.length - shown.length) };
}
