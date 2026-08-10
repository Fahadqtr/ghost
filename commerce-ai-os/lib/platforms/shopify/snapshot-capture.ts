import "server-only";
// Malikas V2 — Shopify snapshot capture (Phase UI.9.5). SERVER-ONLY.
//
// Persists ONE reliable snapshot per Malika product for Shopify into
// platform_snapshots, built ENTIRELY from the EXISTING trusted Shopify read model
// (loadShopifyCatalog, UI.3) — it adds no additional Shopify client, credentials
// flow, API reader, catalog fetcher, scheduled job or event hook. READ-only on
// Shopify + products;
// INSERT-only on platform_snapshots through the SESSION client (RLS) — no service
// role, no product/inventory/platform_status write, no RPC. Idempotent via the
// engine's payload-hash dedupe: re-capturing an unchanged catalog writes nothing.
//
// SAFE BY CONSTRUCTION:
//  - A degraded/unavailable Shopify read is SKIPPED (never written) so a transient
//    outage can never record a product as "missing".
//  - Persistence failure is caught and reported — it NEVER throws into the caller,
//    so it can never break the primary Shopify read or the dashboard.
//  - Bounded: the reader is already page/cap bounded; inputs are additionally
//    capped (MAX_SHOPIFY_SNAPSHOT_INPUTS) and the store chunks inserts.

import type { SnapshotInput } from "../core/types.ts";
import type { CaptureStore } from "../core/capture.ts";
import { rowsToSnapshotInputs, type ShopifyRowInput } from "./capture-compute.ts";

export interface CaptureShopifyResult {
  ok: boolean;
  /** true when the read was degraded/unavailable and capture was safely skipped */
  skipped: boolean;
  error?: string;
  total: number; // products with a trusted verdict (snapshot inputs built)
  created: number;
  changed: number;
  unchanged: number;
  events: number;
  capturedAt?: string;
}

const BASE: CaptureShopifyResult = {
  ok: false,
  skipped: false,
  total: 0,
  created: 0,
  changed: 0,
  unchanged: 0,
  events: 0,
};

/** The trusted Shopify read this capture consumes (structurally loadShopifyCatalog). */
export interface ShopifyCatalogRead {
  status: string;
  shopifyAvailable?: boolean;
  rows?: readonly ShopifyRowInput[];
}
export type ShopifyCatalogLoader = (client: unknown) => Promise<ShopifyCatalogRead>;

/** The engine capture step (injected in tests; the real batch helper in prod). */
export type CaptureRunner = (store: CaptureStore, inputs: readonly SnapshotInput[]) => Promise<{
  created: number;
  changed: number;
  unchanged: number;
  events: unknown[];
}>;

async function defaultLoadCatalog(client: unknown): Promise<ShopifyCatalogRead> {
  const m = await import("@/lib/catalog-v2/shopify-catalog-read");
  return (await m.loadShopifyCatalog(client as never)) as unknown as ShopifyCatalogRead;
}

async function defaultStore(client: unknown): Promise<CaptureStore> {
  const { SupabaseSnapshotStore } = await import("../core/supabase-store.ts");
  return new SupabaseSnapshotStore(client as never);
}

async function defaultCapture(): Promise<CaptureRunner> {
  const { captureSnapshots } = await import("../core/capture.ts");
  return (store, inputs) => captureSnapshots(store, inputs);
}

/**
 * Capture Shopify snapshots from the trusted read model. Best-effort and
 * bounded. A degraded read returns `{ skipped: true }` with NO write. Any
 * failure returns `{ ok: false, error }` (a fixed message) and never throws.
 * `capturedAt` MUST be supplied by the caller (the engine never reads a clock).
 */
export async function captureShopifySnapshots(
  client: unknown,
  capturedAt: string,
  deps?: {
    loadCatalog?: ShopifyCatalogLoader;
    store?: CaptureStore;
    capture?: CaptureRunner;
  },
): Promise<CaptureShopifyResult> {
  try {
    const loadCatalog = deps?.loadCatalog ?? defaultLoadCatalog;
    const read = await loadCatalog(client);
    // Only a trusted, AVAILABLE read produces snapshots — never write on a
    // degraded/unavailable read (would risk recording "missing" falsely).
    if (read.status !== "ok" || read.shopifyAvailable !== true) {
      return { ...BASE, ok: true, skipped: true };
    }

    const inputs = rowsToSnapshotInputs(read.rows ?? [], capturedAt);
    if (inputs.length === 0) return { ...BASE, ok: true, capturedAt };

    const store = deps?.store ?? (await defaultStore(client));
    const capture = deps?.capture ?? (await defaultCapture());
    const result = await capture(store, inputs);

    return {
      ok: true,
      skipped: false,
      total: inputs.length,
      created: result.created,
      changed: result.changed,
      unchanged: result.unchanged,
      events: result.events.length,
      capturedAt,
    };
  } catch {
    // Includes the case where the migration hasn't been applied yet (table
    // missing) — the dashboard simply stays "Unknown"/reader-fallback for Shopify.
    return { ...BASE, error: "تعذّر حفظ لقطات Shopify حاليًا." };
  }
}
