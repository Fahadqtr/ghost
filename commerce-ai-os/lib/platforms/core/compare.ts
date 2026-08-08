// Malikas V2 — Platform Snapshot Engine (Phase UI.9.2): set comparison.
//
// Lifts the pairwise diff engine to whole snapshot SETS: line up a "previous"
// and a "current" set by identity key and emit one diff per key, plus a
// summary. Works across many products and many platforms at once (keys are
// platform-scoped), and stays platform-agnostic.

import type { PlatformSnapshot } from "./types.ts";
import { snapshotKey } from "./snapshot.ts";
import { diffSnapshot, type SnapshotDiff, type SnapshotChangeKind } from "./diff.ts";

export interface CompareSummary {
  created: number;
  deleted: number;
  changed: number;
  unchanged: number;
  total: number;
}

export interface CompareResult {
  diffs: SnapshotDiff[];
  summary: CompareSummary;
}

function indexByKey(snapshots: readonly PlatformSnapshot[]): Map<string, PlatformSnapshot> {
  const map = new Map<string, PlatformSnapshot>();
  for (const s of snapshots) map.set(snapshotKey(s), s);
  return map;
}

/** Roll up per-diff kinds into counts. */
export function summarizeDiffs(diffs: readonly SnapshotDiff[]): CompareSummary {
  const summary: CompareSummary = { created: 0, deleted: 0, changed: 0, unchanged: 0, total: diffs.length };
  for (const d of diffs) summary[d.kind as SnapshotChangeKind]++;
  return summary;
}

/**
 * Compare a previous snapshot set against the current one. Every key present in
 * either set yields exactly one diff:
 *   only in current  → created
 *   only in previous → deleted
 *   in both          → changed / unchanged
 * Diffs are returned in a stable order: previous-set keys first (in their
 * order), then current-only keys (in their order). If a set contains duplicate
 * keys, the LAST occurrence wins (a later capture supersedes an earlier one).
 */
export function compareSnapshots(
  previous: readonly PlatformSnapshot[],
  current: readonly PlatformSnapshot[],
): CompareResult {
  const prev = indexByKey(previous);
  const curr = indexByKey(current);

  const diffs: SnapshotDiff[] = [];
  const seen = new Set<string>();

  for (const key of prev.keys()) {
    seen.add(key);
    diffs.push(diffSnapshot(prev.get(key)!, curr.get(key) ?? null));
  }
  for (const key of curr.keys()) {
    if (seen.has(key)) continue;
    diffs.push(diffSnapshot(null, curr.get(key)!));
  }

  return { diffs, summary: summarizeDiffs(diffs) };
}
