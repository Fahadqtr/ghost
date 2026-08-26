// RAFEEQ.PKGJOB — downloadable-artifact selection (PURE).
//
// Owner rule (DOWNLOAD LAST COMPLETED PACKAGE): the download-only actions must
// find the latest COMPLETE job of a mode whose durable storage artifact still
// exists — ignoring running jobs, failed jobs, incomplete jobs and records
// whose artifact is missing — and NEVER create a job or regenerate anything.
// This module holds the selection semantics so node:test proves them without
// I/O; the server layer feeds it bookkeeping rows and performs the storage
// existence check on the ordered candidates (falling back to the next-newest
// valid candidate when the newest row's artifact is gone).

import type { RafeeqFullSyncMode } from "./fullsync.ts";

export interface RafeeqJobRowCandidate {
  id: string;
  mode: RafeeqFullSyncMode | string;
  status: string;
  createdAt: string;
  artifactFilename: string | null;
  artifactBytes: number | null;
  productsTotal: number;
  imagesDone: number;
  packageId: string | null;
}

/**
 * The ordered download candidates for a mode: COMPLETE rows that recorded an
 * artifact, newest first. Running/failed/incomplete rows and rows without an
 * artifact are excluded here; the caller still verifies storage per candidate
 * and moves to the next one when files are missing.
 */
export function selectDownloadCandidates(
  rows: readonly RafeeqJobRowCandidate[],
  mode: RafeeqFullSyncMode,
): RafeeqJobRowCandidate[] {
  return rows
    .filter((r) => r.mode === mode && r.status === "complete" && !!r.artifactFilename)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

/** History candidates across BOTH modes (same completeness rules), newest first. */
export function selectHistoryCandidates(rows: readonly RafeeqJobRowCandidate[], limit: number): RafeeqJobRowCandidate[] {
  return rows
    .filter((r) => r.status === "complete" && !!r.artifactFilename)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
    .slice(0, Math.max(0, limit));
}
