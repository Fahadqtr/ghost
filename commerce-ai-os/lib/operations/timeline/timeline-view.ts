// Malikas V2 Operations — Product Timeline view layer (Phase UI.7.4).
//
// PURE UI helpers: filter / search / format the engine-aggregated TimelineEvents
// for the screen. NO business logic and NO source-derivation live here — events
// arrive already built + ordered by the TimelineEngine (from its providers). No
// database, no fetch, no "now" clock (dates are formatted by parsing the ISO
// string, never Date.now()), no randomness.

import type { TimelineEvent, TimelineEventKind } from "../shared/models";

// ── filters ──────────────────────────────────────────────────────────────────

export type TimelineFilter = "all" | "created" | "updated" | "approval" | "platform";

export const TIMELINE_FILTER_VALUES: readonly TimelineFilter[] = [
  "all",
  "created",
  "updated",
  "approval",
  "platform",
];

export const TIMELINE_FILTER_LABELS: Record<TimelineFilter, string> = {
  all: "الكل",
  created: "الإنشاء",
  updated: "التحديثات",
  approval: "الاعتماد",
  platform: "النشر",
};

/** Which filter bucket a kind belongs to. Partial: only the snapshot-derived
 *  kinds shown on the product timeline are mapped; other providers' kinds (e.g.
 *  TickTick integration events) have no product-filter bucket and are ignored
 *  by this view. */
const KIND_FILTER: Partial<Record<TimelineEventKind, Exclude<TimelineFilter, "all">>> = {
  created: "created",
  updated: "updated",
  approved: "approval",
  rejected: "approval",
  sent_to_ai: "approval",
  published: "platform",
};

/** Apply one filter (order-preserving; the engine already ordered the list).
 *  "all" keeps every event; a specific filter keeps only kinds mapped to it. */
export function filterTimelineEvents(
  events: readonly TimelineEvent[],
  filter: TimelineFilter,
): TimelineEvent[] {
  if (filter === "all") return [...events];
  return events.filter((e) => KIND_FILTER[e.kind] === filter);
}

/** Search the fixed Arabic title/description text (case-insensitive). A blank or
 *  whitespace-only query is a passthrough. */
export function searchTimelineEvents(
  events: readonly TimelineEvent[],
  query: string,
): TimelineEvent[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...events];
  return events.filter((e) =>
    [e.title, e.description].some((v) => v.toLowerCase().includes(q)),
  );
}

// ── controls (validated GET state) ───────────────────────────────────────────

export interface TimelineControls {
  query: string;
  filter: TimelineFilter;
}

export function parseTimelineControls(
  params: Record<string, string | string[] | undefined> | null | undefined,
): TimelineControls {
  const one = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? "") : (v ?? ""));
  const rawFilter = one(params?.filter);
  const filter = (TIMELINE_FILTER_VALUES as readonly string[]).includes(rawFilter)
    ? (rawFilter as TimelineFilter)
    : "all";
  return { query: one(params?.query).slice(0, 80), filter };
}

/** Full server-side pipeline: filter → search (events arrive already ordered). */
export function selectTimelineEvents(
  events: readonly TimelineEvent[],
  controls: TimelineControls,
): TimelineEvent[] {
  return searchTimelineEvents(filterTimelineEvents(events, controls.filter), controls.query);
}

// ── summary ──────────────────────────────────────────────────────────────────

export interface TimelineSummary {
  total: number;
  created: number;
  updated: number;
  approval: number;
  platform: number;
}

/** Counts over the WHOLE event set (never the filtered/searched subset). */
export function summarizeTimeline(events: readonly TimelineEvent[]): TimelineSummary {
  const s: TimelineSummary = { total: 0, created: 0, updated: 0, approval: 0, platform: 0 };
  for (const e of events) {
    s.total++;
    const bucket = KIND_FILTER[e.kind];
    if (bucket) s[bucket]++;
  }
  return s;
}

// ── labels / icons / date formatting (single-sourced + testable) ─────────────

/** Fixed Arabic kind label (for a per-event chip). Partial over the shared union
 *  — the product timeline renders only snapshot kinds; other providers' kinds
 *  fall back to a generic label at the call site. */
export const TIMELINE_KIND_LABELS: Partial<Record<TimelineEventKind, string>> = {
  created: "إنشاء",
  updated: "تحديث",
  approved: "اعتماد",
  rejected: "رفض",
  sent_to_ai: "ذكاء اصطناعي",
  published: "نشر",
};

/** Icon key per kind (the component turns it into a glyph). Partial for the same
 *  reason as TIMELINE_KIND_LABELS. */
export const TIMELINE_ICONS: Partial<Record<TimelineEventKind, string>> = {
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
export function formatTimelineDate(at: string | null): string {
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

/** The product-detail «النشاط» widget: the latest N events (the list arrives
 *  newest-first from the engine, so the first N ARE the latest N) + how many
 *  remain. Defaults to 10 — the widget's contract. */
export function timelineWidgetEvents(
  events: readonly TimelineEvent[],
  limit = 10,
): { shown: TimelineEvent[]; remaining: number } {
  const shown = events.slice(0, limit);
  return { shown, remaining: Math.max(0, events.length - shown.length) };
}
