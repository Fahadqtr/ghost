import "server-only";
// Malikas operational master scope — the SINGLE membership reader.
//
// Reads `product_id` (and nothing else) from ACTIVE `snoonu:malikas` rows in
// `external_channel_listings`, through the caller's session client. The
// storefront/status constants are the ones the certified catalog reader already
// uses, so the Home Dashboard and /v2/catalog can never drift apart.
//
// READ-ONLY: no write, no RPC, no external call, no product-data read. The
// master size is derived from the rows returned — never a constant.

import { cache } from "react";

import { CATALOG_MAPPING_STATUS, CATALOG_STOREFRONT_KEY } from "../catalog-v2/master-membership.ts";
import { buildMasterScope, UNAVAILABLE_SCOPE, type MasterScope } from "./master-scope.ts";

/** Page size at/below the PostgREST default max-rows, so no page is truncated. */
const PAGE_SIZE = 1000;
/** Safety cap; a source larger than this is read up to the cap and no further. */
const MAX_LISTINGS = 20000;

interface QueryResult {
  data: unknown[] | null;
  error: unknown | null;
}

/** Minimal read surface (only what this reader needs) — injectable for tests. */
export interface ScopeRangeBuilder extends PromiseLike<QueryResult> {
  filter(column: string, operator: string, value: string): ScopeRangeBuilder;
  order(column: string, options: { ascending: boolean }): ScopeRangeBuilder;
  range(from: number, to: number): ScopeRangeBuilder;
}
export interface ScopeSelectBuilder {
  select(columns: string): ScopeRangeBuilder;
}
export interface ScopeReadClient {
  from(table: string): ScopeSelectBuilder;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Read the master membership. Any page failure returns an UNAVAILABLE scope —
 * callers must then show "unavailable", never fall back to the whole catalog.
 */
export async function readMasterScope(client: ScopeReadClient): Promise<MasterScope> {
  const rows: unknown[] = [];
  let offset = 0;
  for (;;) {
    let res: unknown;
    try {
      res = await client
        .from("external_channel_listings")
        .select("product_id")
        .filter("storefront_key", "eq", CATALOG_STOREFRONT_KEY)
        .filter("mapping_status", "eq", CATALOG_MAPPING_STATUS)
        .order("product_id", { ascending: true })
        .order("id", { ascending: true })
        .range(offset, offset + PAGE_SIZE - 1);
    } catch {
      return UNAVAILABLE_SCOPE; // never re-surface the raw error
    }
    if (!(isPlainObject(res) && res.error === null && Array.isArray(res.data))) {
      return UNAVAILABLE_SCOPE;
    }
    const page = res.data;
    for (const row of page) rows.push(row);
    if (rows.length >= MAX_LISTINGS) break;
    if (page.length < PAGE_SIZE) break; // short page → source exhausted
    offset += PAGE_SIZE;
  }
  return buildMasterScope(rows);
}

/** Per-request cached master scope for the Home Dashboard composition. */
export const loadMasterScope = cache(async (): Promise<MasterScope> => {
  try {
    // Lazily bound so node:test can load this module (only relative imports are
    // resolved statically); production still uses the same session client.
    const { createClient } = await import("@/lib/supabase/server");
    return await readMasterScope(createClient() as unknown as ScopeReadClient);
  } catch {
    return UNAVAILABLE_SCOPE;
  }
});
