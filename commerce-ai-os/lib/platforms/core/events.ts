// Malikas V2 — Platform Snapshot Engine (Phase UI.9.2): diff events.
//
// Turns a SnapshotDiff into a transport-neutral PlatformDiffEvent. This is a
// PLAIN DATA shape only — it is deliberately NOT wired to the Timeline, the
// dashboard, or any store in this phase. A later phase (UI.9.3) decides how/
// whether these events are persisted or projected into the Timeline.

import type { PlatformId } from "./types.ts";
import type { SnapshotChangeKind, SnapshotDiff, SnapshotFieldChange } from "./diff.ts";

export const PLATFORM_DIFF_EVENT_TYPE = "platform.snapshot.diff" as const;

export interface PlatformDiffEvent {
  type: typeof PLATFORM_DIFF_EVENT_TYPE;
  platform: PlatformId;
  key: string;
  productId: string | null;
  externalId: string | null;
  kind: SnapshotChangeKind;
  /** field-change flags (empty unless kind === "changed") */
  changes: SnapshotFieldChange[];
  /** when the change was observed: the present side's capturedAt */
  occurredAt: string;
  snapshotVersion: number;
}

/**
 * Build a diff event, or `null` for an "unchanged" diff (no event worth
 * emitting). `occurredAt` comes from the present snapshot's capturedAt — the
 * engine never reads a clock.
 */
export function toDiffEvent(diff: SnapshotDiff): PlatformDiffEvent | null {
  if (diff.kind === "unchanged") return null;
  const present = diff.after ?? diff.before;
  if (!present) return null;
  return {
    type: PLATFORM_DIFF_EVENT_TYPE,
    platform: diff.platform,
    key: diff.key,
    productId: diff.productId,
    externalId: present.externalId,
    kind: diff.kind,
    changes: diff.changes,
    occurredAt: present.capturedAt,
    snapshotVersion: present.snapshotVersion,
  };
}

/** Map a batch of diffs to events, dropping "unchanged" ones. */
export function toDiffEvents(diffs: readonly SnapshotDiff[]): PlatformDiffEvent[] {
  const events: PlatformDiffEvent[] = [];
  for (const d of diffs) {
    const e = toDiffEvent(d);
    if (e) events.push(e);
  }
  return events;
}
