// Malikas V2 — TickTick timeline provider (Phase UI.7.5). PURE: sync records in,
// TimelineEvent[] out. It implements the shared TimelineProvider contract and is
// passed to the existing TimelineEngine unchanged — a new SOURCE, not new engine
// logic.
//
// It emits ONLY verified integration events (a real create/update/complete that
// the sync actually performed). Timestamps are used ONLY when TickTick returned
// one (record.at); otherwise atKnown=false — a time is NEVER invented (this
// module reads no clock at all).

import type { TimelineEvent, TimelineEventKind } from "@/lib/operations/shared/models";
import type { TimelineProvider } from "@/lib/operations/timeline/providers/timeline-provider";
import type { TickTickSyncItemResult } from "./types";

const SOURCE = "ticktick" as const;

type TickTickTimelineKind = Extract<
  TimelineEventKind,
  "ticktick_synced" | "ticktick_updated" | "ticktick_completed"
>;

const TITLES: Record<TickTickTimelineKind, string> = {
  ticktick_synced: "أُرسلت المهمة إلى TickTick",
  ticktick_updated: "حُدّثت المهمة في TickTick",
  ticktick_completed: "أُغلقت المهمة في TickTick",
};

const DESCRIPTIONS: Record<TickTickTimelineKind, string> = {
  ticktick_synced: "أُنشئت مهمة مقابلة في TickTick لتنفيذها ومتابعتها.",
  ticktick_updated: "جرى تحديث بيانات المهمة المقابلة في TickTick.",
  ticktick_completed: "لم يعد سبب المهمة قائمًا في ماليكاس، فأُغلقت في TickTick.",
};

/** Only sync actions that represent a REAL, verified change become events. */
function kindFor(action: TickTickSyncItemResult["action"]): TickTickTimelineKind | null {
  switch (action) {
    case "created": return "ticktick_synced";
    case "updated": return "ticktick_updated";
    case "completed": return "ticktick_completed";
    default: return null; // skipped / failed → no timeline event
  }
}

/** Build TimelineEvents from a sync run's records. */
export function toTimelineEvents(records: readonly TickTickSyncItemResult[]): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  for (const rec of records) {
    const kind = kindFor(rec.action);
    if (kind === null) continue;
    const at = typeof rec.at === "string" && rec.at.trim() !== "" ? rec.at : null;
    events.push({
      id: `${SOURCE}:${kind}:${rec.operationTaskId}`,
      source: SOURCE,
      productId: rec.productId,
      kind,
      at,
      atKnown: at !== null,
      title: TITLES[kind],
      description: DESCRIPTIONS[kind],
    });
  }
  return events;
}

/** A TimelineProvider over a completed sync run — closes over its records.
 *  PURE (no I/O, no clock). Passed to buildTimeline alongside other providers
 *  when TickTick data is available. */
export function createTickTickTimelineProvider(
  records: readonly TickTickSyncItemResult[],
): TimelineProvider {
  return {
    source: SOURCE,
    getEvents: () => toTimelineEvents(records),
  };
}
