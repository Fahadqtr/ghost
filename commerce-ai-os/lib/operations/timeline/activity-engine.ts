// Malikas V2 Operations — Product Timeline & Activity Engine (Phase UI.7.4).
//
// PURE: activity events are COMPUTED from a product snapshot, never stored.
// Recomputing over the same snapshot yields the same events with the same
// deterministic ids (`<kind>:<productId>`), so any surface (the timeline page,
// the product-detail widget, a future export) can diff/de-duplicate safely.
// No database, no fetch, no storage, no "now" clock, no randomness — the only
// time input is the snapshot's own trusted column strings.
//
// Malikas is the Single Source of Truth. Malikas keeps no per-field audit
// history and this phase adds none, so the engine derives events ONLY from the
// two trusted timestamp columns (created_at, updated_at) plus the current
// approval / platform_status state — it never fabricates a timestamp and never
// re-implements readiness/task business logic.

import type {
  ActivityEvent,
  ActivityEventKind,
  ActivityProductSnapshot,
} from "../shared/models";

// Fixed Arabic copy — never reflects raw data.
const TITLES: Record<ActivityEventKind, string> = {
  created: "أُنشئ المنتج",
  updated: "تحديث البيانات",
  approved: "تم اعتماد المنتج",
  rejected: "تم رفض المنتج",
  sent_to_ai: "أُرسل للذكاء الاصطناعي",
  published: "منشور على منصة",
};

const DESCRIPTIONS: Record<ActivityEventKind, string> = {
  created: "تمت إضافة المنتج إلى كتالوج ماليكاس.",
  updated: "جرى تعديل بيانات المنتج بعد إنشائه.",
  approved: "المنتج معتمد وجاهز ليُنشر على المنصات.",
  rejected: "المنتج مرفوض ولن يُنشر حتى تُعالج ملاحظاته.",
  sent_to_ai: "المنتج قيد التجهيز عبر الذكاء الاصطناعي.",
  published: "المنتج مدفوع إلى منصة بيع واحدة على الأقل.",
};

/** Order among events that share the same anchor time (lower = shown first,
 *  i.e. newest/topmost). "created" always sinks to the bottom on a tie. */
const KIND_RANK: Record<ActivityEventKind, number> = {
  updated: 0,
  approved: 1,
  rejected: 1,
  sent_to_ai: 1,
  published: 2,
  created: 3,
};

function hasText(v: string | null | undefined): v is string {
  return typeof v === "string" && v.trim() !== "";
}

/** Parse a timestamp string to epoch ms, or null when absent/unparseable.
 *  Deterministic: depends only on the input string, never on the current time. */
function parseTime(s: string | null): number | null {
  if (!hasText(s)) return null;
  const n = Date.parse(s);
  return Number.isFinite(n) ? n : null;
}

/** Sort key for a time string: finite epoch, or -Infinity when unknown (an
 *  unknown time always sorts to the oldest/bottom position). */
function timeKey(s: string | null): number {
  const n = parseTime(s);
  return n === null ? Number.NEGATIVE_INFINITY : n;
}

/** Normalize the raw approval text to a house state, or null when blank/other. */
function normalizeApproval(raw: string | null): "approved" | "rejected" | "sent_to_ai" | null {
  if (!hasText(raw)) return null;
  const v = raw.trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (v === "approved") return "approved";
  if (v === "rejected") return "rejected";
  if (v === "sentai" || v === "senttoai") return "sent_to_ai";
  return null;
}

function mkEvent(
  kind: ActivityEventKind,
  productId: string,
  at: string | null,
  atKnown: boolean,
): ActivityEvent {
  return {
    id: `${kind}:${productId}`,
    productId,
    kind,
    at,
    atKnown,
    title: TITLES[kind],
    description: DESCRIPTIONS[kind],
  };
}

/**
 * Stable, deterministic ordering: most recent first by anchor time, then by a
 * fixed per-kind rank (so events sharing a timestamp always order the same
 * way), then by id. Non-mutating; sorting the same list twice is idempotent.
 */
export function sortActivityEvents(events: readonly ActivityEvent[]): ActivityEvent[] {
  return [...events].sort((a, b) => {
    const t = timeKey(b.at) - timeKey(a.at); // newest first
    if (t !== 0) return t;
    const r = KIND_RANK[a.kind] - KIND_RANK[b.kind];
    if (r !== 0) return r;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * Derive the timeline for ONE product from its snapshot. Rules (each event is
 * emitted only when its trusted source exists — an unknown source is silently
 * omitted, never guessed):
 * - created: created_at is present and parseable.
 * - updated: updated_at is present, parseable, and strictly LATER than
 *   created_at (a genuine later edit; an unchanged row shows only "created").
 * - approved / rejected / sent_to_ai: the current approval state, anchored to
 *   the last-change time (updated_at, else created_at) with atKnown=false.
 * - published: platform_status is non-empty, anchored the same way.
 * The result is returned in display order (newest first).
 */
export function deriveActivityEvents(snapshot: ActivityProductSnapshot): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  const pid = snapshot.id;
  if (!hasText(pid)) return events;

  const createdT = parseTime(snapshot.createdAt);
  const updatedT = parseTime(snapshot.updatedAt);

  if (createdT !== null) {
    events.push(mkEvent("created", pid, snapshot.createdAt, true));
  }
  const hasLaterUpdate = updatedT !== null && (createdT === null || updatedT > createdT);
  if (hasLaterUpdate) {
    events.push(mkEvent("updated", pid, snapshot.updatedAt, true));
  }

  // Anchor for state events: the last-change time we can trust.
  const anchor =
    updatedT !== null ? snapshot.updatedAt : createdT !== null ? snapshot.createdAt : null;

  const approval = normalizeApproval(snapshot.approval);
  if (approval !== null) {
    events.push(mkEvent(approval, pid, anchor, false));
  }
  if (hasText(snapshot.platformStatus)) {
    events.push(mkEvent("published", pid, anchor, false));
  }

  return sortActivityEvents(events);
}
