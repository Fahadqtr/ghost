import "server-only";
// Malikas V2 — Platform Snapshot Engine (Phase UI.9.3): Supabase adapter.
//
// Implements the SnapshotStore port (PR #532) on the `platform_snapshots` table
// via the SESSION client (RLS: authenticated select+insert). READ + INSERT only
// — never update/delete (snapshots are immutable) and NEVER any product /
// inventory / platform_status write. No service role, no RPC. Any read failure
// degrades to "no data" (→ Unknown), never "missing".

import type { PlatformSnapshot } from "./types.ts";
import type { SnapshotStore, SnapshotQuery } from "./storage.ts";
import { snapshotKey } from "./snapshot.ts";
import { diffSnapshot, type SnapshotDiff } from "./diff.ts";
import type { CaptureStore } from "./capture.ts";

const TABLE = "platform_snapshots";
const INSERT_CHUNK = 200;
const LATEST_SCAN_CAP = 50_000; // upper bound on rows scanned for latest-per-product
const PRODUCT_HISTORY_CAP = 500; // upper bound on one product's history read (UI.9.4)

interface QueryResult {
  data: unknown[] | null;
  error: unknown | null;
}
interface SelectChain extends PromiseLike<QueryResult> {
  eq(column: string, value: unknown): SelectChain;
  order(column: string, opts: { ascending: boolean }): SelectChain;
  limit(n: number): SelectChain;
}
interface TableApi {
  select(columns: string): SelectChain;
  insert(rows: Record<string, unknown>[]): PromiseLike<{ error: unknown | null }>;
}
/** Minimal client surface (structurally the Supabase session client). */
export interface SnapshotStoreClient {
  from(table: string): TableApi;
}

const COLUMNS =
  "platform, product_id, external_id, sku, barcode, status, price, availability, title, payload_hash, snapshot_version, captured_at, metadata";

function toRow(s: PlatformSnapshot): Record<string, unknown> {
  return {
    platform: s.platform,
    product_id: s.productId,
    external_id: s.externalId,
    sku: s.sku,
    barcode: s.barcode,
    status: s.status,
    price: s.price,
    availability: s.availability,
    title: s.title,
    payload_hash: s.payloadHash,
    snapshot_version: s.snapshotVersion,
    captured_at: s.capturedAt,
    metadata: s.metadata,
  };
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : v == null ? null : String(v);
}
function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function fromRow(r: Record<string, unknown>): PlatformSnapshot {
  const meta = r.metadata;
  return {
    platform: String(r.platform ?? ""),
    productId: r.product_id == null ? null : String(r.product_id),
    externalId: str(r.external_id),
    sku: str(r.sku),
    barcode: str(r.barcode),
    status: str(r.status),
    price: numOrNull(r.price),
    availability: str(r.availability),
    title: str(r.title),
    payloadHash: String(r.payload_hash ?? ""),
    snapshotVersion: numOrNull(r.snapshot_version) ?? 1,
    capturedAt: String(r.captured_at ?? ""),
    metadata: meta && typeof meta === "object" ? (meta as Record<string, unknown>) : {},
  };
}

/** Parse an engine key "platform::id" into its parts (id treated as product_id;
 *  external-id/sku fallbacks are a future extension). */
function parseKey(key: string): { platform: string; id: string } {
  const i = key.indexOf("::");
  return i < 0 ? { platform: key, id: "" } : { platform: key.slice(0, i), id: key.slice(i + 2) };
}

export class SupabaseSnapshotStore implements SnapshotStore, CaptureStore {
  private readonly client: SnapshotStoreClient;

  constructor(client: SnapshotStoreClient) {
    this.client = client;
  }

  async saveSnapshot(snapshot: PlatformSnapshot): Promise<void> {
    const { error } = await this.client.from(TABLE).insert([toRow(snapshot)]);
    if (error) throw new Error("snapshot_save_failed");
  }

  async saveSnapshots(snapshots: readonly PlatformSnapshot[]): Promise<void> {
    for (let i = 0; i < snapshots.length; i += INSERT_CHUNK) {
      const chunk = snapshots.slice(i, i + INSERT_CHUNK).map(toRow);
      const { error } = await this.client.from(TABLE).insert(chunk);
      if (error) throw new Error("snapshot_save_failed");
    }
  }

  async loadLatest(key: string): Promise<PlatformSnapshot | null> {
    const { platform, id } = parseKey(key);
    if (!platform || !id) return null;
    const { data, error } = await this.client
      .from(TABLE)
      .select(COLUMNS)
      .eq("platform", platform)
      .eq("product_id", id)
      .order("captured_at", { ascending: false })
      .limit(1);
    if (error) throw new Error("snapshot_read_failed");
    const rows = Array.isArray(data) ? data : [];
    return rows.length ? fromRow(rows[0] as Record<string, unknown>) : null;
  }

  async compareLatest(next: PlatformSnapshot): Promise<SnapshotDiff> {
    const previous = await this.loadLatest(snapshotKey(next));
    return diffSnapshot(previous, next);
  }

  async listSnapshots(query?: SnapshotQuery): Promise<PlatformSnapshot[]> {
    let q = this.client.from(TABLE).select(COLUMNS).order("captured_at", { ascending: true });
    if (query?.platform !== undefined) q = q.eq("platform", query.platform);
    if (query?.productId !== undefined && query.productId !== null) q = q.eq("product_id", query.productId);
    const { data, error } = await q;
    if (error) throw new Error("snapshot_read_failed");
    let rows = (Array.isArray(data) ? data : []).map((r) => fromRow(r as Record<string, unknown>));
    if (query?.key !== undefined) rows = rows.filter((s) => snapshotKey(s) === query.key);
    return rows;
  }

  /**
   * All snapshots for ONE product, newest-first, BOUNDED (Phase UI.9.4). A
   * targeted read for the product-page platform history: `product_id` equality,
   * optional `platform` scope, capped `limit`. READ-only, session client (RLS).
   * The cap protects the request even if a product accrues a long history.
   */
  async listByProduct(
    productId: string,
    opts?: { platform?: string; limit?: number },
  ): Promise<PlatformSnapshot[]> {
    const lim = Math.min(Math.max(1, Math.trunc(opts?.limit ?? PRODUCT_HISTORY_CAP)), PRODUCT_HISTORY_CAP);
    let q = this.client.from(TABLE).select(COLUMNS).eq("product_id", productId);
    if (opts?.platform !== undefined && opts.platform !== "") q = q.eq("platform", opts.platform);
    q = q.order("captured_at", { ascending: false }).limit(lim);
    const { data, error } = await q;
    if (error) throw new Error("snapshot_read_failed");
    return (Array.isArray(data) ? data : []).map((r) => fromRow(r as Record<string, unknown>));
  }

  /**
   * Latest snapshot per product for a platform. Reads rows newest-first (capped)
   * and keeps the first seen per product_id. Powers capture diffing and the
   * dashboard read.
   */
  async listLatestByPlatform(platform: string): Promise<PlatformSnapshot[]> {
    const { data, error } = await this.client
      .from(TABLE)
      .select(COLUMNS)
      .eq("platform", platform)
      .order("captured_at", { ascending: false })
      .limit(LATEST_SCAN_CAP);
    if (error) throw new Error("snapshot_read_failed");
    const rows = (Array.isArray(data) ? data : []).map((r) => fromRow(r as Record<string, unknown>));
    const latest = new Map<string, PlatformSnapshot>();
    for (const s of rows) {
      const k = snapshotKey(s);
      if (!latest.has(k)) latest.set(k, s); // newest-first ⇒ first seen is latest
    }
    return [...latest.values()];
  }
}
