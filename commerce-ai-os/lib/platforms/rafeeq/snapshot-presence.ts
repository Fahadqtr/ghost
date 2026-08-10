import "server-only";
// Malikas V2 — Rafeeq snapshot reader for the dashboard (Phase UI.9.7).
// SERVER-ONLY, READ-ONLY. Combines two trusted, persisted signals into a
// per-product RafeeqState:
//   1. the latest platform_snapshot per product (present / missing / linked) —
//      the confident captured verdict, and the source of freshness;
//   2. a baseline from channel_products.channel_status for the EXACTLY-resolved
//      Rafeeq channel — an honest "current DB overlay" fallback for products with
//      no snapshot yet.
// Snapshot verdict wins; else the baseline; else the product is absent (→ the
// read model reports "unknown"). A snapshot read FAILURE degrades to unknown
// (never missing); the baseline read is best-effort (failure → no baseline, never
// missing). A missing/ambiguous Rafeeq channel yields no baseline. Short cache
// (90s, successful reads only). Store/channel reads are bound lazily; tests inject.

import type { PlatformSnapshot } from "../core/types.ts";
import type { SnapshotStoreClient } from "../core/supabase-store.ts";
import {
  RAFEEQ_PLATFORM,
  classifyRafeeqSnapshot,
  isSnapshotStale,
  rafeeqVerdictFor,
  resolveRafeeqChannelId,
  type RafeeqState,
} from "./capture-compute.ts";

const TTL_MS = 90_000;
let cache: { at: number; data: RafeeqSnapshotView } | null = null;

/** Test-only: clear the module cache between cases. */
export function __resetRafeeqSnapshotCache(): void {
  cache = null;
}

export interface RafeeqSnapshotView {
  /** true when EITHER a snapshot OR a channel_products baseline carried data */
  available: boolean;
  /** true when the snapshot read FAILED (→ unknown, never missing) */
  degraded: boolean;
  /** productId → RafeeqState (snapshot verdict wins; else channel_status baseline) */
  byProductId: Map<string, RafeeqState>;
  /** newest captured_at across Rafeeq snapshots, or null */
  lastCapturedAt: string | null;
  /** true when the newest snapshot is older than the adopted stale window (7d) */
  stale: boolean;
}

const PAGE = 1000;

function sbFrom(client: unknown, table: string) {
  return (client as { from: (t: string) => any }).from(table);
}

/** Best-effort baseline: current channel_status per product for the exactly
 *  resolved Rafeeq channel. Any failure / missing / ambiguous channel → empty
 *  map (never surfaces an error, never implies missing). */
async function defaultLoadBaseline(client: SnapshotStoreClient): Promise<Map<string, RafeeqState>> {
  const out = new Map<string, RafeeqState>();
  try {
    const { data: chans, error: chErr } = await sbFrom(client, "channels").select("id, name");
    if (chErr) return out;
    const channelId = resolveRafeeqChannelId((chans ?? []) as { id: string; name: string | null }[]);
    if (channelId === null) return out;
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await sbFrom(client, "channel_products")
        .select("product_id, channel_status")
        .eq("channel_id", channelId)
        .range(from, from + PAGE - 1);
      if (error) return out;
      const rows = (Array.isArray(data) ? data : []) as { product_id: string; channel_status: string | null }[];
      for (const r of rows) {
        const id = String(r.product_id ?? "");
        if (!id) continue;
        // Baseline uses channel_status only (no external id here) — recognized
        // statuses become present/missing/linked; anything else is skipped.
        const verdict = rafeeqVerdictFor(r.channel_status ?? null, null);
        if (verdict) out.set(id, verdict);
      }
      if (rows.length < PAGE) break;
    }
  } catch {
    return new Map();
  }
  return out;
}

export async function loadRafeeqSnapshotView(
  client: SnapshotStoreClient,
  deps?: {
    listLatest?: (c: SnapshotStoreClient) => Promise<PlatformSnapshot[]>;
    loadBaseline?: (c: SnapshotStoreClient) => Promise<Map<string, RafeeqState>>;
    now?: () => number;
  },
): Promise<RafeeqSnapshotView> {
  const now = (deps?.now ?? Date.now)();
  if (cache && now - cache.at < TTL_MS) return cache.data;

  const listLatest =
    deps?.listLatest ??
    (async (c: SnapshotStoreClient) =>
      new (await import("../core/supabase-store.ts")).SupabaseSnapshotStore(c).listLatestByPlatform(RAFEEQ_PLATFORM));

  let snapshots: PlatformSnapshot[];
  try {
    snapshots = await listLatest(client);
  } catch {
    // snapshot read failed → degraded (NOT cached; retries next call). Never "missing".
    return { available: false, degraded: true, byProductId: new Map(), lastCapturedAt: null, stale: true };
  }

  const byProductId = new Map<string, RafeeqState>();
  let lastCapturedAt: string | null = null;
  for (const s of snapshots) {
    if (s.productId) byProductId.set(s.productId, classifyRafeeqSnapshot(s));
    if (s.capturedAt && (lastCapturedAt === null || s.capturedAt > lastCapturedAt)) lastCapturedAt = s.capturedAt;
  }

  // Baseline — best-effort; fills products that have a channel_status but no
  // snapshot yet. Snapshot verdicts always win. Failure → no baseline (never missing).
  const loadBaseline = deps?.loadBaseline ?? defaultLoadBaseline;
  let baseline: Map<string, RafeeqState>;
  try {
    baseline = await loadBaseline(client);
  } catch {
    baseline = new Map();
  }
  for (const [id, state] of baseline) if (!byProductId.has(id)) byProductId.set(id, state);

  const data: RafeeqSnapshotView = {
    available: byProductId.size > 0,
    degraded: false,
    byProductId,
    lastCapturedAt,
    stale: isSnapshotStale(lastCapturedAt, now),
  };
  cache = { at: now, data }; // cache successful reads (incl. healthy-empty)
  return data;
}
