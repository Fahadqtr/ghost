// Malikas V2 Operations — Snapshot Timeline Provider (Phase UI.7.4).
//
// The FIRST (and today only) TimelineProvider: it derives TimelineEvents from a
// Malikas product snapshot. This is the ONLY module that knows how a snapshot
// becomes events — the TimelineEngine stays source-agnostic. PURE: models in,
// events out; no database, no fetch, no storage, no "now" clock, no randomness.
//
// Honest by construction — Malikas keeps no per-field audit history and this
// phase adds none, so events are derived ONLY from trusted sources and a
// timestamp is never fabricated. An unknown/blank source yields no event.

import type {
  TimelineEvent,
  TimelineEventKind,
  TimelineProductSnapshot,
} from "../../shared/models";
import type { TimelineProvider } from "./timeline-provider";

const SOURCE = "snapshot" as const;

// Fixed Arabic copy — never reflects raw data.
const TITLES: Record<TimelineEventKind, string> = {
  created: "أُنشئ المنتج",
  updated: "تحديث البيانات",
  approved: "تم اعتماد المنتج",
  rejected: "تم رفض المنتج",
  sent_to_ai: "أُرسل للذكاء الاصطناعي",
  published: "منشور على منصة",
};

const DESCRIPTIONS: Record<TimelineEventKind, string> = {
  created: "تمت إضافة المنتج إلى كتالوج ماليكاس.",
  updated: "جرى تعديل بيانات المنتج بعد إنشائه.",
  approved: "المنتج معتمد وجاهز ليُنشر على المنصات.",
  rejected: "المنتج مرفوض ولن يُنشر حتى تُعالج ملاحظاته.",
  sent_to_ai: "المنتج قيد التجهيز عبر الذكاء الاصطناعي.",
  published: "المنتج مدفوع إلى منصة بيع واحدة على الأقل.",
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
  kind: TimelineEventKind,
  productId: string,
  at: string | null,
  atKnown: boolean,
): TimelineEvent {
  return {
    // id carries the source so it stays unique when other providers are added.
    id: `${SOURCE}:${kind}:${productId}`,
    source: SOURCE,
    productId,
    kind,
    at,
    atKnown,
    title: TITLES[kind],
    description: DESCRIPTIONS[kind],
  };
}

/**
 * Derive the snapshot's timeline events (UNORDERED — the engine owns global
 * ordering across providers). Rules — each event is emitted only when its
 * trusted source exists (an unknown source is silently omitted, never guessed):
 * - created: created_at is present and parseable.
 * - updated: updated_at is present, parseable, and strictly LATER than created_at.
 * - approved / rejected / sent_to_ai: the current approval state, anchored to
 *   the last-change time (updated_at, else created_at) with atKnown=false.
 * - published: platform_status is non-empty, anchored the same way.
 */
export function deriveSnapshotEvents(snapshot: TimelineProductSnapshot): TimelineEvent[] {
  const events: TimelineEvent[] = [];
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

  return events;
}

/** Build the snapshot provider — closes over the already-read snapshot. PURE. */
export function createSnapshotTimelineProvider(
  snapshot: TimelineProductSnapshot,
): TimelineProvider {
  return {
    source: SOURCE,
    getEvents: () => deriveSnapshotEvents(snapshot),
  };
}

/** Map a whitelisted `products` row into the snapshot shape. Pure and defensive
 *  — non-string/blank cells become null, values are never coerced. Lives with
 *  the snapshot provider because the raw-row shape is snapshot-source-specific. */
export function mapSnapshotRow(row: Record<string, unknown>): TimelineProductSnapshot {
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
