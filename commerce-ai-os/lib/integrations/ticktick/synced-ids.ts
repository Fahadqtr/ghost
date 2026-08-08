import "server-only";
// Malikas V2 — TickTick "synced task ids" reader (Phase UI.8). SERVER-ONLY, READ
// ONLY. Returns the set of Malikas OperationTask ids that currently have a
// mirrored task in TickTick (matched by our deterministic marker), so the
// Operations dashboard can show TickTick-linked counts/badges WITHOUT any write.
//
// It NEVER creates/updates/completes anything (it only calls listProjectTasks),
// NEVER blocks the dashboard (any failure → { available:false, ids:∅ }), and
// NEVER leaks a token or raw error. Results are cached briefly — this is a
// read-only display signal, so short staleness is safe, and the cache keeps the
// dashboard fast. Only successful reads are cached.

// Runtime deps (client/mapper) are loaded lazily inside the function so this
// module's STATIC imports stay type-only and it loads directly under node:test —
// mirroring adapter.ts / shopify-presence.ts. Tests inject every dep, so the
// dynamic imports below are production-only.
import type { TickTickClient, TickTickProjectMap, TickTickTaskRecord } from "./types";

export interface TickTickSyncedResult {
  /** true only when a TickTick read actually succeeded */
  available: boolean;
  /** OperationTask ids present in TickTick (empty when not connected/unavailable) */
  ids: Set<string>;
}

const TTL_MS = 60_000;
let cache: { at: number; data: TickTickSyncedResult } | null = null;

/** Test-only: clear the synced-ids cache between cases. */
export function __resetTickTickSyncedCache(): void {
  cache = null;
}

/** Unique, non-empty project ids from the env-configured map. */
function uniqueProjectIds(map: TickTickProjectMap): string[] {
  const out = new Set<string>();
  for (const v of Object.values(map)) {
    if (typeof v === "string" && v.trim() !== "") out.add(v);
  }
  return [...out];
}

/**
 * The set of OperationTask ids currently mirrored in TickTick. Best-effort:
 * degrades to { available:false, ids:∅ } when TickTick is not configured, no
 * project is configured, or the read fails — the dashboard then simply shows 0
 * linked tasks. Dependencies are injected in tests (no network).
 */
export async function loadTickTickSyncedIds(deps?: {
  client?: TickTickClient;
  projectMap?: TickTickProjectMap;
  configured?: boolean;
  parse?: (content: string | null | undefined) => string | null;
  now?: () => number;
}): Promise<TickTickSyncedResult> {
  const now = (deps?.now ?? Date.now)();
  if (cache && now - cache.at < TTL_MS) return cache.data;

  const configured = deps?.configured ?? (await import("./client")).ticktickConfigured();
  if (!configured) return { available: false, ids: new Set() };

  const map = deps?.projectMap ?? (await import("./client")).projectMapFromEnv();
  const projectIds = uniqueProjectIds(map);
  if (projectIds.length === 0) return { available: false, ids: new Set() };

  try {
    const client = deps?.client ?? (await import("./client")).getTickTickClient();
    const parse = deps?.parse ?? (await import("./mapper")).parseMarker;
    const records: TickTickTaskRecord[] = await client.listProjectTasks(projectIds);
    const ids = new Set<string>();
    for (const rec of records) {
      const marker = parse(rec.content);
      if (marker) ids.add(marker);
    }
    const data: TickTickSyncedResult = { available: true, ids };
    cache = { at: now, data }; // cache only a successful read
    return data;
  } catch {
    // Never surface a raw error or break the dashboard.
    return { available: false, ids: new Set() };
  }
}
