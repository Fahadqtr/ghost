// Malikas V2 — Platform Snapshot Engine (Phase UI.9.4): history view helpers.
//
// PURE presentation helpers for the platform-history section: fixed Arabic labels
// for platforms / fields / change types, a before→after formatter, an absolute
// date formatter (string-parsed, no clock), and bounded pagination over already-
// built entries. NO business logic and NO data access — entries arrive already
// derived + ordered by history.ts. Never renders raw metadata.

import type {
  PlatformChangeType,
  PlatformFieldDelta,
  PlatformHistoryEntry,
  PlatformHistoryField,
} from "./history.ts";

/** Fixed Arabic platform labels. Unknown ids fall back to the id itself (an
 *  opaque enum, never user/raw data), so a future platform still renders. */
const PLATFORM_LABELS: Record<string, string> = {
  puresoul: "PureSoul",
  pure_seoul: "PureSoul",
  shopify: "Shopify",
  talabat: "Talabat",
  rafeeq: "Rafeeq",
};

export function platformLabel(platform: string): string {
  return PLATFORM_LABELS[platform] ?? platform;
}

export const FIELD_LABELS: Record<PlatformHistoryField, string> = {
  price: "السعر",
  availability: "التوفّر",
  status: "الحالة",
  title: "الاسم",
  sku: "SKU",
  barcode: "الباركود",
  external_id: "معرّف المنصة",
};

export function fieldLabel(field: PlatformHistoryField): string {
  return FIELD_LABELS[field];
}

export const CHANGE_TYPE_LABELS: Record<PlatformChangeType, string> = {
  created: "أول لقطة",
  changed: "تحديث",
};

export function changeTypeLabel(t: PlatformChangeType): string {
  return CHANGE_TYPE_LABELS[t];
}

/** Render a single value for display; null/blank → "—". Numbers are stringified
 *  plainly (no locale/clock). Never receives metadata (history excludes it). */
export function formatValue(v: string | number | null): string {
  if (v === null) return "—";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "—";
  const s = v.trim();
  return s === "" ? "—" : s;
}

/** "before ← after" style text for one delta (RTL: after on the left). For a
 *  "created" entry (before === null) it shows just the initial value. */
export function formatDelta(delta: PlatformFieldDelta): string {
  const after = formatValue(delta.after);
  if (delta.before === null) return after;
  return `${formatValue(delta.before)} ← ${after}`;
}

const AR_MONTHS = [
  "يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو",
  "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر",
];

/**
 * Absolute Arabic date from an ISO timestamp ("7 أغسطس 2026"). PURE: parses the
 * YYYY-MM-DD prefix by string ops only — no Date object, no "now" — so the same
 * input always yields the same output. Unknown/unparseable → "—".
 */
export function formatSnapshotDate(at: string | null): string {
  if (typeof at !== "string") return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(at.trim());
  if (m === null) return "—";
  const year = m[1];
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return "—";
  return `${day} ${AR_MONTHS[month - 1]} ${year}`;
}

// ── bounded pagination over already-built entries ────────────────────────────

export interface HistoryPage {
  items: PlatformHistoryEntry[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/**
 * Bounded, clamped pagination of a newest-first entry list. `page` is 1-based;
 * `pageSize` is clamped to [1, 100]. Out-of-range pages yield an empty window
 * (never throws). PURE — slices the already-ordered list.
 */
export function paginateHistory(
  entries: readonly PlatformHistoryEntry[],
  page = 1,
  pageSize = DEFAULT_PAGE_SIZE,
): HistoryPage {
  const size = Math.min(Math.max(1, Math.trunc(pageSize) || DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
  const p = Math.max(1, Math.trunc(page) || 1);
  const start = (p - 1) * size;
  const items = entries.slice(start, start + size);
  return { items, page: p, pageSize: size, total: entries.length, hasMore: start + size < entries.length };
}
