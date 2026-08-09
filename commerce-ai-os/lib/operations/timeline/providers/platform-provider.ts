// Malikas V2 Operations — Platform Timeline Provider (Phase UI.9.4).
//
// Adapts the generic PLATFORM HISTORY (derived from platform_snapshots by
// lib/platforms/core/history) into the source-agnostic Timeline: one provider
// per platform, each returning TimelineEvents the existing engine merges +
// orders with every other source. This is the ONLY module that maps a platform
// history entry to a TimelineEvent — the engine stays untouched. PURE: entries
// in, events out; no I/O, no clock, no randomness.
//
// Honest by construction: entries already exclude "unchanged" captures (history
// emits none), so no event is ever fabricated. capturedAt is a real, trusted
// snapshot time, so atKnown is true. Raw metadata is never carried — the title/
// description use fixed Arabic copy + field LABELS only, never field VALUES.

import type { PlatformHistoryEntry } from "../../../platforms/core/history";
import { platformLabel, fieldLabel } from "../../../platforms/core/history-view.ts";
import type { TimelineEvent, TimelineSource } from "../../shared/models";
import type { TimelineProvider } from "./timeline-provider";

/** Known platform id → Timeline source. Unknown ids yield null and are skipped
 *  (this PR adds no new platform), so an event is never mislabeled. */
const PLATFORM_TO_SOURCE: Record<string, TimelineSource> = {
  puresoul: "puresoul",
  pure_seoul: "puresoul",
  shopify: "shopify",
  talabat: "talabat",
  rafeeq: "rafeeq",
};

export function platformToTimelineSource(platform: string): TimelineSource | null {
  return PLATFORM_TO_SOURCE[platform] ?? null;
}

/** Fixed Arabic copy for the generic (values-free) timeline card. */
function titleFor(entry: PlatformHistoryEntry): string {
  const p = platformLabel(entry.platform);
  return entry.changeType === "created" ? `${p} — أول لقطة` : `${p} — تحديث لقطة`;
}

function descriptionFor(entry: PlatformHistoryEntry): string {
  if (entry.changeType === "created") return "أول لقطة محفوظة لهذا المنتج على المنصة.";
  const labels = entry.fields.map((f) => fieldLabel(f.field));
  if (entry.metadataChanged) labels.push("بيانات إضافية");
  return labels.length > 0 ? `تغيّر: ${labels.join("، ")}.` : "تغيّرت لقطة المنصة.";
}

/** Map one history entry to a TimelineEvent. id is deterministic over
 *  (source, changeType, productId, capturedAt) so recompute yields the same id
 *  and the engine can de-duplicate. */
function toEvent(entry: PlatformHistoryEntry, source: TimelineSource): TimelineEvent {
  const pid = entry.productId ?? "";
  const kind = entry.changeType === "created" ? "platform_created" : "platform_changed";
  return {
    id: `platform:${source}:${entry.changeType}:${pid}:${entry.capturedAt}`,
    source,
    productId: pid,
    kind,
    at: entry.capturedAt,
    atKnown: true, // snapshot capturedAt is a real, trusted observation time
    title: titleFor(entry),
    description: descriptionFor(entry),
  };
}

/** Events for a single platform's entries (already that platform's). PURE. */
export function platformTimelineEvents(
  entries: readonly PlatformHistoryEntry[],
  source: TimelineSource,
): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  for (const entry of entries) {
    if (entry.productId === null || entry.productId === "") continue; // timeline needs a product
    out.push(toEvent(entry, source));
  }
  return out;
}

/** One provider per platform present in `entries`; entries on an unknown
 *  platform id are skipped (no source to map to). Pass the result straight to
 *  buildTimeline([...]) alongside any other providers — the engine is unchanged. */
export function createPlatformTimelineProviders(
  entries: readonly PlatformHistoryEntry[],
): TimelineProvider[] {
  const byPlatform = new Map<string, PlatformHistoryEntry[]>();
  for (const e of entries) {
    const g = byPlatform.get(e.platform);
    if (g) g.push(e);
    else byPlatform.set(e.platform, [e]);
  }
  const providers: TimelineProvider[] = [];
  for (const [platform, group] of byPlatform) {
    const source = platformToTimelineSource(platform);
    if (source === null) continue; // unknown platform → skip (no new platform this PR)
    providers.push({ source, getEvents: () => platformTimelineEvents(group, source) });
  }
  return providers;
}
