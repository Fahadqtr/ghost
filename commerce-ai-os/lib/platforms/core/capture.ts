// Malikas V2 — Platform Snapshot Engine (Phase UI.9.3): batch capture.
//
// Generic, platform-agnostic capture orchestration over an injected store:
// build snapshots → diff each against the stored latest → persist ONLY
// created/changed → emit diff events. IDEMPOTENT: re-capturing an identical set
// writes nothing (every item diffs "unchanged"), so a repeated same upload never
// creates inconsistent or duplicated state. Pure orchestration — it performs no
// I/O itself; the store does.

import type { PlatformSnapshot, SnapshotInput } from "./types.ts";
import { createSnapshot as defaultCreateSnapshot, snapshotKey } from "./snapshot.ts";
import { diffSnapshot } from "./diff.ts";
import { toDiffEvent, type PlatformDiffEvent } from "./events.ts";

/** The subset of a store that capture needs (kept small for testability). */
export interface CaptureStore {
  /** latest snapshot per identity for a platform (used to diff the new set) */
  listLatestByPlatform(platform: string): Promise<PlatformSnapshot[]>;
  /** persist new snapshots (append-only) */
  saveSnapshots(snapshots: readonly PlatformSnapshot[]): Promise<void>;
}

export interface CaptureResult {
  created: number;
  changed: number;
  unchanged: number;
  saved: PlatformSnapshot[];
  events: PlatformDiffEvent[];
}

/**
 * Capture a batch of snapshot inputs. Only created/changed snapshots are saved;
 * unchanged ones are skipped (idempotent). Returns counts, the saved snapshots,
 * and the diff events (unchanged emits none). Groups by platform so a mixed
 * batch still diffs against the right latest set.
 */
export async function captureSnapshots(
  store: CaptureStore,
  inputs: readonly SnapshotInput[],
  deps?: { createSnapshot?: typeof defaultCreateSnapshot },
): Promise<CaptureResult> {
  const create = deps?.createSnapshot ?? defaultCreateSnapshot;
  const result: CaptureResult = { created: 0, changed: 0, unchanged: 0, saved: [], events: [] };

  const snapshots = inputs.map(create);
  if (snapshots.length === 0) return result;

  // Load the latest stored snapshot per identity, once per platform present.
  const prevByKey = new Map<string, PlatformSnapshot>();
  for (const platform of new Set(snapshots.map((s) => s.platform))) {
    for (const prev of await store.listLatestByPlatform(platform)) prevByKey.set(snapshotKey(prev), prev);
  }

  const toSave: PlatformSnapshot[] = [];
  for (const s of snapshots) {
    const d = diffSnapshot(prevByKey.get(snapshotKey(s)) ?? null, s);
    if (d.kind === "unchanged") {
      result.unchanged++;
      continue;
    }
    if (d.kind === "created") result.created++;
    else result.changed++; // "deleted" can't occur — s is always the present side
    toSave.push(s);
    const event = toDiffEvent(d);
    if (event) result.events.push(event);
  }

  if (toSave.length > 0) await store.saveSnapshots(toSave);
  result.saved = toSave;
  return result;
}
