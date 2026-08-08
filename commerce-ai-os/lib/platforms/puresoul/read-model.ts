import "server-only";
// Malikas V2 — PureSoul overlay reader (Phase UI.9.1). SERVER-ONLY, READ-ONLY.
//
// PureSoul has NO API; its reliable persisted snapshot is the shared
// `platform_status` overlay (platform='pure_seoul'), populated from the owner's
// PureSoul export uploads. This reads those rows through the SESSION client
// (RLS) — paginated — and returns them raw. No admin client, no service role,
// no RPC, no write, no SQL/migration. Any read error degrades (never partial,
// never "missing"). The pure mapper turns rows into presence.
//
// Static imports are TYPE-ONLY so this loads directly under node:test.

import type { PureSoulOverlayRow } from "./types";

const PS_PLATFORM = "pure_seoul";
const PAGE_SIZE = 1000;
const MAX_ROWS = 50_000; // safety cap — the overlay is far smaller in practice

interface QueryResult {
  data: unknown[] | null;
  error: unknown | null;
}
interface RangeBuilder extends PromiseLike<QueryResult> {
  eq(column: string, value: string): RangeBuilder;
  range(from: number, to: number): RangeBuilder;
}
interface SelectBuilder {
  select(columns: string): RangeBuilder;
}
/** The minimal read surface this reader needs (structurally the Supabase session
 *  client). Only select/eq/range — no insert/update/delete/rpc exist here. */
export interface PureSoulReadClient {
  from(table: string): SelectBuilder;
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

export interface PureSoulOverlayRead {
  rows: PureSoulOverlayRow[];
  /** true when the read FAILED (caller must treat as unknown, never missing) */
  degraded: boolean;
}

/**
 * Read all PureSoul overlay rows (READ-ONLY). Returns `degraded:true` on ANY
 * read error — with no rows — so the dashboard shows "تعذر قراءة PureSoul" and
 * never reports products as missing. A healthy but empty overlay returns
 * `{ rows: [], degraded: false }` (PureSoul simply not synced yet).
 */
export async function loadPureSoulOverlayRows(client: PureSoulReadClient): Promise<PureSoulOverlayRead> {
  const rows: PureSoulOverlayRow[] = [];
  try {
    for (let from = 0; from < MAX_ROWS; from += PAGE_SIZE) {
      const { data, error } = await client
        .from("platform_status")
        .select("product_id, approval, availability")
        .eq("platform", PS_PLATFORM)
        .range(from, from + PAGE_SIZE - 1);
      if (error) return { rows: [], degraded: true };
      const page = Array.isArray(data) ? data : [];
      for (const r of page) {
        if (r === null || typeof r !== "object") continue;
        const o = r as Record<string, unknown>;
        const pid = strOrNull(o.product_id);
        if (pid) rows.push({ productId: pid, approval: strOrNull(o.approval), availability: strOrNull(o.availability) });
      }
      if (page.length < PAGE_SIZE) break;
    }
  } catch {
    return { rows: [], degraded: true }; // never re-surface the raw error
  }
  return { rows, degraded: false };
}
