import "server-only";
// Malikas V2 — CI.1 product platform matrix reader (server-only, READ-only).
//
// The thin reader behind the product page's "حالة المنصات" section. It reuses the
// EXISTING bounded, RLS, newest-first `SupabaseSnapshotStore.listByProduct` (the
// same method the platform-history reader uses — no new query type, no new table,
// no service role, no admin client, no RPC) and projects the latest snapshot per
// platform into the pure PlatformMatrixItem. Any read failure degrades to an
// all-"unknown" matrix (never "missing", never a raw DB error). Snapshot-only:
// the matrix reflects captured history (the operations dashboard carries the live
// fallback separately). Store + clock are injectable for tests.

import type { PlatformSnapshot } from "../platforms/core/types.ts";
import { buildProductPlatformMatrix, type PlatformMatrixItem } from "./platform-matrix.ts";

const PRODUCT_ID_MAX = 200;

/** Minimal store surface (structurally SupabaseSnapshotStore). */
export interface MatrixSnapshotStore {
  listByProduct(productId: string, opts?: { platform?: string; limit?: number }): Promise<PlatformSnapshot[]>;
}

async function defaultStore(client: unknown): Promise<MatrixSnapshotStore> {
  const { SupabaseSnapshotStore } = await import("@/lib/platforms/core/supabase-store");
  return new SupabaseSnapshotStore(client as never);
}

/** Empty (all-unknown) matrix — used for a blank/invalid id or a degraded read. */
function emptyMatrix(productId: string, sku: string | null, barcode: string | null, now: number): PlatformMatrixItem {
  return buildProductPlatformMatrix(productId, sku, barcode, [], now);
}

/**
 * Load the product platform matrix for ONE product. Bounded, session client, RLS.
 * Returns an all-"unknown" matrix for a blank/invalid id or any read failure —
 * never throws, never surfaces a raw error, never writes. `sku`/`barcode` are for
 * the item header only (from the already-loaded product row).
 */
export async function loadProductPlatformMatrix(
  client: unknown,
  productId: unknown,
  opts?: {
    sku?: string | null;
    barcode?: string | null;
    now?: number;
    deps?: { store?: MatrixSnapshotStore };
  },
): Promise<PlatformMatrixItem> {
  const now = opts?.now ?? Date.now();
  const sku = opts?.sku ?? null;
  const barcode = opts?.barcode ?? null;
  if (typeof productId !== "string" || productId.trim() === "" || productId.length > PRODUCT_ID_MAX) {
    return emptyMatrix(typeof productId === "string" ? productId : "", sku, barcode, now);
  }
  try {
    const store = opts?.deps?.store ?? (await defaultStore(client));
    let snapshots: PlatformSnapshot[];
    try {
      snapshots = await store.listByProduct(productId); // bounded, newest-first, all platforms
    } catch {
      return emptyMatrix(productId, sku, barcode, now); // degraded → all unknown, never missing
    }
    return buildProductPlatformMatrix(productId, sku, barcode, snapshots, now);
  } catch {
    return emptyMatrix(productId, sku, barcode, now);
  }
}
