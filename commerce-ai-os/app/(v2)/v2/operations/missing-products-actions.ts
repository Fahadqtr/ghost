"use server";

// CH.6F — Missing Products Discovery & Repair SERVER ACTIONS.
//
// Thin wrappers over the orchestrator. Scan + report are READ-ONLY and open to
// any signed-in user (preview). ECL repair and product import are writer-gated
// INSIDE the orchestrator (requireMalakWriter) and route every write through the
// approved boundaries (ECL insert boundary / create core + inventory
// initializer). These actions add no DB, write, or AI logic of their own; the
// client never holds a DB/admin client.

import { revalidatePath } from "next/cache";
import {
  scanMissingProducts,
  readOnlyGapReport,
  applyEclRepairs,
  importExternalOnly,
  type ScanResult,
  type ScanFilters,
  type GapReport,
  type ApplyResult,
  type ImportSelection,
} from "@/lib/missing-products/discovery.server";
import { GAP_STATUSES, type GapStatus } from "@/lib/missing-products/discovery-model";

function parseFilters(raw: unknown): ScanFilters {
  const f = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const status = typeof f.status === "string" && (GAP_STATUSES as readonly string[]).includes(f.status) ? (f.status as GapStatus) : undefined;
  const grain = f.grain === "product" || f.grain === "variant" ? f.grain : undefined;
  return {
    status,
    grain,
    brand: typeof f.brand === "string" && f.brand ? f.brand : undefined,
    sku: typeof f.sku === "string" && f.sku ? f.sku : undefined,
  };
}

export async function scanMissingProductsAction(storefront: string, filters?: unknown): Promise<ScanResult | { error: string }> {
  return scanMissingProducts({ storefront: String(storefront ?? ""), filters: parseFilters(filters) });
}

export async function gapReportAction(): Promise<GapReport | { error: string }> {
  return readOnlyGapReport();
}

export async function applyEclRepairsAction(storefront: string, keys: string[]): Promise<ApplyResult | { error: string }> {
  const list = Array.isArray(keys) ? keys.filter((k) => typeof k === "string" && k) : [];
  const res = await applyEclRepairs({ storefront: String(storefront ?? ""), keys: list });
  if (!("error" in res)) revalidatePath("/v2/operations/missing-products");
  return res;
}

export async function importExternalOnlyAction(
  storefront: string,
  category: string,
  subCategory: string,
  selections: ImportSelection[],
): Promise<ApplyResult | { error: string }> {
  const list = Array.isArray(selections) ? selections.filter((s) => s && typeof s === "object") : [];
  const res = await importExternalOnly({
    storefront: String(storefront ?? ""),
    category: String(category ?? ""),
    subCategory: String(subCategory ?? ""),
    selections: list,
  });
  if (!("error" in res)) revalidatePath("/v2/operations/missing-products");
  return res;
}
