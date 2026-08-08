// Malikas V2 — Platform Snapshot Engine (Phase UI.9.2): storage interface.
//
// Defines the SnapshotStore port and ships an in-memory adapter for tests and
// local reasoning. NO SQL, NO migration, NO Supabase, NO service role — a real
// persistent adapter is a LATER phase (UI.9.3). Everything here is process-
// local and pure aside from the Map it owns.

import type { PlatformId, PlatformSnapshot } from "./types.ts";
import { snapshotKey } from "./snapshot.ts";
import { diffSnapshot, type SnapshotDiff } from "./diff.ts";

/** Optional filter for listSnapshots. All fields AND together. */
export interface SnapshotQuery {
  platform?: PlatformId;
  productId?: string | null;
  key?: string;
}

/**
 * Persistence port for snapshots. Deliberately minimal so a future DB adapter
 * (UI.9.3) can implement the same four methods without touching callers.
 */
export interface SnapshotStore {
  /** Persist a snapshot (append-only history per key). */
  saveSnapshot(snapshot: PlatformSnapshot): Promise<void>;
  /** Latest stored snapshot for an identity key, or null if none. */
  loadLatest(key: string): Promise<PlatformSnapshot | null>;
  /** Diff `next` against the latest stored snapshot for its key (created if none). */
  compareLatest(next: PlatformSnapshot): Promise<SnapshotDiff>;
  /** All stored snapshots matching the query (insertion order), newest last. */
  listSnapshots(query?: SnapshotQuery): Promise<PlatformSnapshot[]>;
}

/** "Latest" = the snapshot with the greatest capturedAt; ties break toward the
 *  most recently inserted (stable, clock-free). */
function pickLatest(history: readonly PlatformSnapshot[]): PlatformSnapshot | null {
  let latest: PlatformSnapshot | null = null;
  for (const s of history) {
    if (latest === null || s.capturedAt >= latest.capturedAt) latest = s;
  }
  return latest;
}

/**
 * In-memory SnapshotStore for tests and local development. Keeps an append-only
 * history per identity key in insertion order. Not persistent, not shared across
 * processes — never a production store.
 */
export class InMemorySnapshotStore implements SnapshotStore {
  private readonly byKey = new Map<string, PlatformSnapshot[]>();
  private readonly order: PlatformSnapshot[] = [];

  async saveSnapshot(snapshot: PlatformSnapshot): Promise<void> {
    const key = snapshotKey(snapshot);
    const history = this.byKey.get(key);
    if (history) history.push(snapshot);
    else this.byKey.set(key, [snapshot]);
    this.order.push(snapshot);
  }

  async loadLatest(key: string): Promise<PlatformSnapshot | null> {
    return pickLatest(this.byKey.get(key) ?? []);
  }

  async compareLatest(next: PlatformSnapshot): Promise<SnapshotDiff> {
    const previous = await this.loadLatest(snapshotKey(next));
    return diffSnapshot(previous, next);
  }

  async listSnapshots(query?: SnapshotQuery): Promise<PlatformSnapshot[]> {
    return this.order.filter((s) => {
      if (query?.platform !== undefined && s.platform !== query.platform) return false;
      if (query?.productId !== undefined && s.productId !== query.productId) return false;
      if (query?.key !== undefined && snapshotKey(s) !== query.key) return false;
      return true;
    });
  }
}
