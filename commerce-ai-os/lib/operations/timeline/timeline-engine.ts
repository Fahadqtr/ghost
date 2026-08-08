// Malikas V2 Operations — Timeline Engine (Phase UI.7.4).
//
// SOURCE-AGNOSTIC aggregator. The engine receives TimelineEvent[] from one or
// more TimelineProviders and MERGES + orders them into a single timeline. It
// does NOT know how any source derives its events (that lives in each provider),
// so a new provider is added by passing it to buildTimeline — never by changing
// the engine. PURE: no database, no fetch, no storage, no "now" clock, no
// randomness (ordering uses Date.parse on the events' own timestamp strings).

import type { TimelineEvent, TimelineEventKind } from "../shared/models";
import type { TimelineProvider } from "./providers/timeline-provider";

/** Order among events that share the same anchor time (lower = shown first,
 *  i.e. newest/topmost). "created" always sinks to the bottom on a tie. The map
 *  is Partial: a kind with no explicit entry (e.g. a new provider's kind) falls
 *  back to DEFAULT_RANK via rankOf — so adding contract kinds needs NO engine
 *  logic change. */
const KIND_RANK: Partial<Record<TimelineEventKind, number>> = {
  updated: 0,
  approved: 1,
  rejected: 1,
  sent_to_ai: 1,
  published: 2,
  created: 3,
};
const DEFAULT_RANK = 2;

function rankOf(kind: TimelineEventKind): number {
  return KIND_RANK[kind] ?? DEFAULT_RANK;
}

/** Sort key for a time string: finite epoch, or -Infinity when unknown (an
 *  unknown time always sorts to the oldest/bottom position). */
function timeKey(s: string | null): number {
  if (typeof s !== "string" || s.trim() === "") return Number.NEGATIVE_INFINITY;
  const n = Date.parse(s);
  return Number.isFinite(n) ? n : Number.NEGATIVE_INFINITY;
}

/**
 * Stable, deterministic ordering across ALL sources: most recent first by time,
 * then by a fixed per-kind rank (so events sharing a timestamp always order the
 * same way), then by source, then by id. Non-mutating; idempotent.
 */
export function sortTimelineEvents(events: readonly TimelineEvent[]): TimelineEvent[] {
  return [...events].sort((a, b) => {
    const t = timeKey(b.at) - timeKey(a.at); // newest first
    if (t !== 0) return t;
    const r = rankOf(a.kind) - rankOf(b.kind);
    if (r !== 0) return r;
    if (a.source !== b.source) return a.source < b.source ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Drop duplicate ids, keeping the first occurrence (order-preserving). Two
 *  providers must never claim the same id (the id carries its source), so this
 *  is a safety net for the multi-source / future Event-Store world. */
function dedupeById(events: readonly TimelineEvent[]): TimelineEvent[] {
  const seen = new Set<string>();
  const out: TimelineEvent[] = [];
  for (const e of events) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out;
}

/**
 * Build one product's timeline by aggregating every provider's events, then
 * de-duplicating and ordering them (newest first). Providers are consulted in
 * the order given, but the final order is fully determined by the sort — so the
 * result is independent of provider order. PURE.
 */
export function buildTimeline(providers: readonly TimelineProvider[]): TimelineEvent[] {
  const all: TimelineEvent[] = [];
  for (const provider of providers) {
    for (const event of provider.getEvents()) all.push(event);
  }
  return dedupeById(sortTimelineEvents(all));
}
