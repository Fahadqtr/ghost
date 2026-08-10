import "server-only";
// Malikas V2 — Talabat snapshot reader for the dashboard (Phase UI.9.6).
// SERVER-ONLY, READ-ONLY. Combines two trusted signals into a per-product
// TalabatState:
//   1. the latest platform_snapshot per product (present / missing / review) —
//      the confident, upload-derived verdict, and the source of freshness;
//   2. a baseline from channel_variant_mappings (authenticated READ, RLS): a
//      confirmed channel_product_id ⇒ `linked` (ready) ONLY, never present.
// Snapshot verdict wins; else the mapping baseline; else the product is absent
// (→ the read model reports "unknown"). A snapshot read FAILURE degrades to
// unknown (never missing); the mapping read is best-effort (failure → no
// baseline, never missing). Short cache (90s, successful reads only). The store
// and channel/mappings reads are bound lazily; tests inject them.

import type { PlatformSnapshot } from "../core/types.ts";
import type { SnapshotStoreClient } from "../core/supabase-store.ts";
import {
  TALABAT_PLATFORM,
  classifyTalabatSnapshot,
  isSnapshotStale,
  mappingsToLinkedProductIds,
  resolveTalabatChannelId,
  type TalabatMappingRow,
  type TalabatState,
} from "./capture-compute.ts";

const TTL_MS = 90_000;
let cache: { at: number; data: TalabatSnapshotView } | null = null;

/** Test-only: clear the module cache between cases. */
export function __resetTalabatSnapshotCache(): void {
  cache = null;
}

export interface TalabatSnapshotView {
  /** true when EITHER a snapshot OR a confirmed mapping carried data */
  available: boolean;
  /** true when the snapshot read FAILED (→ unknown, never missing) */
  degraded: boolean;
  /** productId → TalabatState (snapshot verdict wins; else mapping `linked`) */
  byProductId: Map<string, TalabatState>;
  /** newest captured_at across Talabat snapshots, or null */
  lastCapturedAt: string | null;
  /** true when the newest snapshot is older than the adopted stale window (7d) */
  stale: boolean;
}

/** Best-effort baseline: confirmed-mapping product ids for the Talabat channel.
 *  Any failure → empty set (never surfaces an error, never implies missing). */
async function defaultLoadLinkedProductIds(client: SnapshotStoreClient): Promise<Set<string>> {
  try {
    const sb = client as unknown as {
      from: (t: string) => {
        select: (c: string) => {
          eq?: (col: string, val: string) => { range: (a: number, b: number) => Promise<{ data: unknown[] | null; error: unknown }> };
          range?: (a: number, b: number) => Promise<{ data: unknown[] | null; error: unknown }>;
        };
      };
    };
    const chRes = await sb.from("channels").select("id, name").range!(0, 999);
    if (chRes.error) return new Set();
    const channelId = resolveTalabatChannelId((chRes.data ?? []) as { id: string; name: string | null }[]);
    if (channelId === null) return new Set();

    const rows: TalabatMappingRow[] = [];
    for (let from = 0; ; from += 1000) {
      const q = sb.from("channel_variant_mappings").select("master_product_id, channel_product_id, mapping_status");
      const res = await q.eq!("channel_id", channelId).range(from, from + 999);
      if (res.error) return new Set();
      const page = (Array.isArray(res.data) ? res.data : []) as TalabatMappingRow[];
      rows.push(...page);
      if (page.length < 1000) break;
    }
    return mappingsToLinkedProductIds(rows);
  } catch {
    return new Set();
  }
}

export async function loadTalabatSnapshotView(
  client: SnapshotStoreClient,
  deps?: {
    listLatest?: (c: SnapshotStoreClient) => Promise<PlatformSnapshot[]>;
    loadLinkedProductIds?: (c: SnapshotStoreClient) => Promise<Set<string>>;
    now?: () => number;
  },
): Promise<TalabatSnapshotView> {
  const now = (deps?.now ?? Date.now)();
  if (cache && now - cache.at < TTL_MS) return cache.data;

  const listLatest =
    deps?.listLatest ??
    (async (c: SnapshotStoreClient) =>
      new (await import("../core/supabase-store.ts")).SupabaseSnapshotStore(c).listLatestByPlatform(TALABAT_PLATFORM));

  let snapshots: PlatformSnapshot[];
  try {
    snapshots = await listLatest(client);
  } catch {
    // snapshot read failed → degraded (NOT cached; retries next call). Never "missing".
    return { available: false, degraded: true, byProductId: new Map(), lastCapturedAt: null, stale: true };
  }

  const byProductId = new Map<string, TalabatState>();
  let lastCapturedAt: string | null = null;
  for (const s of snapshots) {
    if (s.productId) byProductId.set(s.productId, classifyTalabatSnapshot(s));
    if (s.capturedAt && (lastCapturedAt === null || s.capturedAt > lastCapturedAt)) lastCapturedAt = s.capturedAt;
  }

  // Baseline linkage — best-effort; a product WITHOUT a snapshot verdict but WITH
  // a confirmed mapping is `linked` (ready). Snapshot verdicts always win. A
  // mapping-read failure is swallowed (no baseline, NEVER missing) so it can
  // never degrade the snapshot view.
  const loadLinked = deps?.loadLinkedProductIds ?? defaultLoadLinkedProductIds;
  let linked: Set<string>;
  try {
    linked = await loadLinked(client);
  } catch {
    linked = new Set();
  }
  for (const id of linked) if (!byProductId.has(id)) byProductId.set(id, "linked");

  const data: TalabatSnapshotView = {
    available: byProductId.size > 0,
    degraded: false,
    byProductId,
    lastCapturedAt,
    stale: isSnapshotStale(lastCapturedAt, now),
  };
  cache = { at: now, data }; // cache successful reads (incl. healthy-empty)
  return data;
}
