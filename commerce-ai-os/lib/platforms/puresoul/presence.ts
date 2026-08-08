import "server-only";
// Malikas V2 — PureSoul presence bridge (Phase UI.9.1). SERVER-ONLY, READ-ONLY.
//
// Composes the overlay reader (read-model) with the pure mapper into the
// { available, degraded, byProductId } result the Operations dashboard consumes
// — mirroring lib/operations/shopify-presence. A short cache (90s, SUCCESSFUL
// reads only) keeps the dashboard fast and avoids re-reading the overlay within
// one request; a read FAILURE is never cached (it retries) and degrades to
// unknown — never "missing".
//
// Runtime deps (read-model, mapper) load lazily so this module's STATIC imports
// stay type-only and it loads under node:test; tests inject the deps.

import type { PlatformPresence } from "../../operations/shared/models";
import type { PureSoulOverlayRow, PureSoulReadResult } from "./types";
import type { PureSoulReadClient } from "./read-model";

const TTL_MS = 90_000;
let cache: { at: number; data: PureSoulReadResult } | null = null;

/** Test-only: clear the presence cache between cases. */
export function __resetPureSoulPresenceCache(): void {
  cache = null;
}

export async function loadPureSoulPresence(
  client: PureSoulReadClient,
  deps?: {
    readRows?: (c: PureSoulReadClient) => Promise<{ rows: PureSoulOverlayRow[]; degraded: boolean }>;
    build?: (rows: readonly PureSoulOverlayRow[]) => Map<string, PlatformPresence>;
    now?: () => number;
  },
): Promise<PureSoulReadResult> {
  const now = (deps?.now ?? Date.now)();
  if (cache && now - cache.at < TTL_MS) return cache.data;

  const readRows = deps?.readRows ?? (async (c: PureSoulReadClient) => (await import("./read-model")).loadPureSoulOverlayRows(c));
  const build = deps?.build ?? (await import("./mapper")).buildPureSoulPresence;

  let read: { rows: PureSoulOverlayRow[]; degraded: boolean };
  try {
    read = await readRows(client);
  } catch {
    return { available: false, degraded: true, byProductId: new Map() };
  }
  if (read.degraded) {
    // read FAILED → degraded, empty, and NOT cached (retry on the next call).
    return { available: false, degraded: true, byProductId: new Map() };
  }

  const byProductId = build(read.rows);
  // available only when we actually have PureSoul data; a healthy-empty overlay
  // means "not synced yet" (the UI keeps «غير مربوط»), which is still a
  // successful read and safe to cache.
  const data: PureSoulReadResult = { available: byProductId.size > 0, degraded: false, byProductId };
  cache = { at: now, data };
  return data;
}
