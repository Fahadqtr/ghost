import "server-only";
// Malikas V2 — Rafeeq snapshot capture (Phase UI.9.7). SERVER-ONLY.
//
// Persists ONE reliable snapshot per product for Rafeeq into platform_snapshots,
// built ENTIRELY from the EXISTING DB overlays (products.rafeeq_product_id +
// channel_products.channel_status for the exactly-resolved Rafeeq channel) — it
// adds no Rafeeq API client, credentials flow, catalog fetcher, event receiver or
// scheduled job. READ-only on channels/channel_products/products; INSERT-only on
// platform_snapshots through the SESSION client (RLS) — no service role, no
// product / channel_products / availability-overlay write, no RPC. It changes no
// channel_products / availability-overlay / export semantics.
//
// SAFE BY CONSTRUCTION:
//  - The Rafeeq channel is resolved by EXACT name; missing/ambiguous ⇒ SKIPPED
//    (no write) — never guessed, never recorded as "missing".
//  - Idempotent via the engine's payload-hash dedupe: re-capturing unchanged
//    overlays writes nothing.
//  - Persistence failure is caught and returned as a fixed Arabic message — it
//    NEVER throws into the caller, so it can never break the page.
//  - Bounded: inputs are capped and the store chunks inserts.

import type { SnapshotInput } from "../core/types.ts";
import type { CaptureStore } from "../core/capture.ts";
import {
  buildRafeeqSnapshotInputs,
  resolveRafeeqChannelId,
  type RafeeqProductRow,
} from "./capture-compute.ts";

export interface CaptureRafeeqResult {
  ok: boolean;
  /** true when the Rafeeq channel was missing/ambiguous and capture was skipped */
  skipped: boolean;
  error?: string;
  total: number;
  created: number;
  changed: number;
  unchanged: number;
  events: number;
  capturedAt?: string;
}

const BASE: CaptureRafeeqResult = {
  ok: false,
  skipped: false,
  total: 0,
  created: 0,
  changed: 0,
  unchanged: 0,
  events: 0,
};

const PAGE = 1000;

export type ChannelsLoader = (client: unknown) => Promise<{ id: string; name: string | null }[]>;
export type ChannelStatusLoader = (client: unknown, channelId: string) => Promise<Map<string, string | null>>;
export type ProductsLoader = (client: unknown) => Promise<RafeeqProductRow[]>;
export type CaptureRunner = (
  store: CaptureStore,
  inputs: readonly SnapshotInput[],
) => Promise<{ created: number; changed: number; unchanged: number; events: unknown[] }>;

function sbFrom(client: unknown, table: string) {
  return (client as { from: (t: string) => any }).from(table);
}

async function defaultLoadChannels(client: unknown): Promise<{ id: string; name: string | null }[]> {
  const { data, error } = await sbFrom(client, "channels").select("id, name");
  if (error) throw new Error("channels_read_failed");
  return (Array.isArray(data) ? data : []) as { id: string; name: string | null }[];
}

async function defaultLoadChannelStatuses(client: unknown, channelId: string): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sbFrom(client, "channel_products")
      .select("product_id, channel_status")
      .eq("channel_id", channelId)
      .range(from, from + PAGE - 1);
    if (error) throw new Error("channel_products_read_failed");
    const rows = (Array.isArray(data) ? data : []) as { product_id: string; channel_status: string | null }[];
    for (const r of rows) if (r.product_id) map.set(String(r.product_id), r.channel_status ?? null);
    if (rows.length < PAGE) break;
  }
  return map;
}

async function defaultLoadProducts(client: unknown): Promise<RafeeqProductRow[]> {
  const out: RafeeqProductRow[] = [];
  // barcode / rafeeq_product_id may be absent on older installs — fall back.
  let cols = "id, sku, barcode, name_en, name_ar, rafeeq_product_id";
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sbFrom(client, "products").select(cols).range(from, from + PAGE - 1);
    if (error) {
      if (cols.includes("barcode") || cols.includes("rafeeq_product_id")) {
        cols = "id, sku, name_en, name_ar";
        from -= PAGE;
        continue;
      }
      throw new Error("products_read_failed");
    }
    const rows = (Array.isArray(data) ? data : []) as Record<string, unknown>[];
    for (const p of rows) {
      out.push({
        id: String(p.id ?? ""),
        sku: (p.sku as string) ?? null,
        barcode: (p.barcode as string) ?? null,
        name_en: (p.name_en as string) ?? null,
        name_ar: (p.name_ar as string) ?? null,
        rafeeq_product_id: (p.rafeeq_product_id as string) ?? null,
      });
    }
    if (rows.length < PAGE) break;
  }
  return out;
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
 * Capture Rafeeq snapshots from the DB overlays. Best-effort and bounded. A
 * missing/ambiguous Rafeeq channel returns `{ skipped: true }` with NO write. Any
 * failure returns `{ ok: false, error }` (a fixed message) and never throws.
 * `capturedAt` MUST be supplied by the caller (the engine never reads a clock).
 */
export async function captureRafeeqSnapshots(
  client: unknown,
  capturedAt: string,
  deps?: {
    loadChannels?: ChannelsLoader;
    loadChannelStatuses?: ChannelStatusLoader;
    loadProducts?: ProductsLoader;
    store?: CaptureStore;
    capture?: CaptureRunner;
  },
): Promise<CaptureRafeeqResult> {
  try {
    const loadChannels = deps?.loadChannels ?? defaultLoadChannels;
    const channelId = resolveRafeeqChannelId(await loadChannels(client));
    // Exact channel resolution only — missing/ambiguous ⇒ skip (never guess).
    if (channelId === null) return { ...BASE, ok: true, skipped: true };

    const loadChannelStatuses = deps?.loadChannelStatuses ?? defaultLoadChannelStatuses;
    const loadProducts = deps?.loadProducts ?? defaultLoadProducts;
    const [statusByProductId, products] = await Promise.all([
      loadChannelStatuses(client, channelId),
      loadProducts(client),
    ]);

    const inputs = buildRafeeqSnapshotInputs(products, statusByProductId, capturedAt);
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
    // missing) — the dashboard simply stays "Unknown"/baseline for Rafeeq.
    return { ...BASE, error: "تعذّر حفظ لقطات رفيق حاليًا." };
  }
}
