import "server-only";
// Malikas V2 — Shopify snapshot reader for the dashboard (Phase UI.9.5).
// SERVER-ONLY, READ-ONLY. Reads the latest platform_snapshot per product for
// Shopify, reconstructs each into the SAME PlatformPresence the live UI.3 reader
// produces (so the platform-status engine is untouched), and reports freshness.
// A read FAILURE degrades to unknown (empty map, never "missing"); a healthy-but-
// empty read means "not captured yet" (available:false). Short cache (90s,
// successful reads only) keeps the dashboard fast. The store is loaded lazily so
// static imports stay node-loadable; tests inject `listLatest`.

import type { PlatformPresence } from "../../operations/shared/models";
import type { PlatformSnapshot } from "../core/types.ts";
import type { SnapshotStoreClient } from "../core/supabase-store.ts";
import { SHOPIFY_PLATFORM, isSnapshotStale, snapshotToShopifyPresence } from "./capture-compute.ts";

const TTL_MS = 90_000;
let cache: { at: number; data: ShopifySnapshotView } | null = null;

/** Test-only: clear the module cache between cases. */
export function __resetShopifySnapshotCache(): void {
  cache = null;
}

export interface ShopifySnapshotView {
  /** true when the read succeeded AND at least one snapshot exists */
  available: boolean;
  /** true when the snapshot read FAILED (→ unknown, never missing) */
  degraded: boolean;
  /** productId → reconstructed PlatformPresence (only for products with a snapshot) */
  byProductId: Map<string, PlatformPresence>;
  /** newest captured_at across Shopify snapshots, or null */
  lastCapturedAt: string | null;
  /** true when the newest snapshot is older than the adopted stale window (24h) */
  stale: boolean;
}

export async function loadShopifySnapshotView(
  client: SnapshotStoreClient,
  deps?: {
    listLatest?: (c: SnapshotStoreClient) => Promise<PlatformSnapshot[]>;
    now?: () => number;
  },
): Promise<ShopifySnapshotView> {
  const now = (deps?.now ?? Date.now)();
  if (cache && now - cache.at < TTL_MS) return cache.data;

  const listLatest =
    deps?.listLatest ??
    (async (c: SnapshotStoreClient) =>
      new (await import("../core/supabase-store.ts")).SupabaseSnapshotStore(c).listLatestByPlatform(SHOPIFY_PLATFORM));

  let snapshots: PlatformSnapshot[];
  try {
    snapshots = await listLatest(client);
  } catch {
    // read failed → degraded (NOT cached; retries next call). Never "missing".
    return { available: false, degraded: true, byProductId: new Map(), lastCapturedAt: null, stale: true };
  }

  const byProductId = new Map<string, PlatformPresence>();
  let lastCapturedAt: string | null = null;
  for (const s of snapshots) {
    if (s.productId) byProductId.set(s.productId, snapshotToShopifyPresence(s));
    if (s.capturedAt && (lastCapturedAt === null || s.capturedAt > lastCapturedAt)) lastCapturedAt = s.capturedAt;
  }

  const data: ShopifySnapshotView = {
    available: byProductId.size > 0,
    degraded: false,
    byProductId,
    lastCapturedAt,
    stale: isSnapshotStale(lastCapturedAt, now),
  };
  cache = { at: now, data }; // cache successful reads (incl. healthy-empty)
  return data;
}
