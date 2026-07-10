// CRM customer logic — pure, DB- and network-free.
//
// A "customer" is unified from two sources: Shopify buyers (name, phone, spend,
// order count) and DM contacts (Instagram/WhatsApp conversations). This module
// holds the pure shaping: phone normalization (for matching), the segment
// classifier, and the segment catalogue the UI filters by. Kept pure so the
// rules are unit-tested; the Shopify/Supabase calls live in the /crm action.

export type CustomerSegment = "vip" | "repeat" | "new" | "lapsed" | "lead";

export const VIP_SPEND_QAR = 1000; // total spend that marks a VIP
export const LAPSED_DAYS = 60;     // no order in this many days → lapsed
export const NEW_DAYS = 30;        // first order within this window → new

// Catalogue for the directory filter (order = display order).
export const SEGMENTS: { key: CustomerSegment; ar: string; en: string; emoji: string }[] = [
  { key: "vip", ar: "كبار العملاء", en: "VIP", emoji: "👑" },
  { key: "repeat", ar: "متكرر", en: "Repeat", emoji: "🔁" },
  { key: "new", ar: "جديد", en: "New", emoji: "✨" },
  { key: "lapsed", ar: "غايب", en: "Lapsed", emoji: "🕰️" },
  { key: "lead", ar: "سأل ولم يطلب", en: "Lead", emoji: "💬" },
];

const SEG_BY_KEY = new Map(SEGMENTS.map((s) => [s.key, s]));
export function segmentLabel(key: CustomerSegment, en = false): string {
  const s = SEG_BY_KEY.get(key);
  return s ? `${s.emoji} ${en ? s.en : s.ar}` : key;
}

/** Digits-only phone key for matching; Qatar numbers reduce to their last 8. */
export function normalizePhone(raw: string | null | undefined): string {
  const digits = String(raw ?? "").replace(/\D+/g, "");
  if (!digits) return "";
  // Drop a leading Qatar country code (974) when it leaves a local 8-digit number.
  if (digits.length === 11 && digits.startsWith("974")) return digits.slice(3);
  if (digits.length >= 8) return digits.slice(-8);
  return digits;
}

export function daysSince(iso: string | null | undefined, now: Date): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (isNaN(t)) return null;
  return Math.floor((now.getTime() - t) / 86_400_000);
}

export interface SegmentInput {
  orders: number;
  spent: number;                 // total spend (QAR)
  lastOrderAt?: string | null;
  now: Date;
}

/**
 * One primary segment per customer. Priority: no orders → lead; else VIP wins
 * on spend, then a long gap → lapsed, then repeat (2+), otherwise new.
 */
export function computeSegment(i: SegmentInput): CustomerSegment {
  if (!i.orders || i.orders <= 0) return "lead";
  if (i.spent >= VIP_SPEND_QAR) return "vip";
  const gap = daysSince(i.lastOrderAt, i.now);
  if (gap != null && gap > LAPSED_DAYS) return "lapsed";
  if (i.orders >= 2) return "repeat";
  return "new";
}

/** Tally how many customers fall in each segment (for the filter chips). */
export function segmentCounts(rows: { segment: CustomerSegment }[]): Record<CustomerSegment, number> {
  const out: Record<CustomerSegment, number> = { vip: 0, repeat: 0, new: 0, lapsed: 0, lead: 0 };
  for (const r of rows) out[r.segment] = (out[r.segment] ?? 0) + 1;
  return out;
}
