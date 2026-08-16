import "server-only";
// OPS.4 — Live channel gap-count reader (SERVER-ONLY, READ-ONLY).
//
// Gathers the BOUNDED aggregates the pure gap-count builder needs, using
// COUNT-only (`head: true`) queries — no row transfer, no catalog scan, no CH.6F
// classifier. Cost is fixed regardless of catalog size (§11):
//   • 1 count  — products total
//   • 1 count  — product_variants total (Talabat variant-grain denominator, §6)
//   • 4 counts — active ECL listings per ECL-identity storefront
//   • 1 read   — needs_review ECL rows (rare/contested; bounded LIMIT), grouped in TS
//   = ~7 bounded queries, none returning catalog rows.
// select/count only — no insert/update/delete/upsert/rpc — so it provably writes
// nothing (ECL, inventory, availability all untouched).

import { STOREFRONTS } from "@/lib/channels/storefronts";
import {
  buildGapCounts,
  ECL_GAP_STOREFRONTS,
  type EclStorefrontAggregate,
  type GapCounts,
} from "./gap-counts.ts";

/** Cap on needs_review rows read (contested rows are a small set; bound anyway). */
const NEEDS_REVIEW_CAP = 5000;

interface CountResult { count: number | null; error: unknown | null }
interface CountBuilder extends PromiseLike<CountResult> { eq(col: string, val: string): CountBuilder }
interface RowsResult { data: unknown[] | null; error: unknown | null }
interface RowsBuilder extends PromiseLike<RowsResult> { eq(col: string, val: string): RowsBuilder; limit(n: number): RowsBuilder }
interface Selectable {
  select(cols: string, opts: { count: "exact"; head: true }): CountBuilder;
  select(cols: string): RowsBuilder;
}
export interface GapCountClient { from(table: string): Selectable }

async function headCount(b: CountBuilder): Promise<number | null> {
  const { count, error } = await b;
  return error ? null : count ?? 0;
}

/**
 * Read the per-storefront gap counts. Best-effort: any individual count that
 * fails degrades to UNKNOWN for that storefront (never to 0/"missing"). The
 * Shopify presence overview is passed in (already loaded by the dashboard).
 */
export async function loadChannelGapCounts(
  client: GapCountClient,
  shopifyPresence: { available: boolean; mapped: number; missing: number; review: number },
): Promise<Record<string, GapCounts>> {
  // Denominators (COUNT-only).
  const productsTotal = await headCount(client.from("products").select("id", { count: "exact", head: true }));
  const variantsTotal = await headCount(client.from("product_variants").select("id", { count: "exact", head: true }));

  // Active mapped per ECL-identity storefront (COUNT-only, one per storefront).
  const ecl: Record<string, EclStorefrontAggregate | undefined> = {};
  for (const key of ECL_GAP_STOREFRONTS) {
    const activeMapped = await headCount(
      client
        .from("external_channel_listings")
        .select("id", { count: "exact", head: true })
        .eq("storefront_key", key)
        .eq("mapping_status", "active"),
    );
    // seed with 0 needs_review; the single needs_review read below fills it in
    ecl[key] = activeMapped === null ? undefined : { activeMapped, needsReview: 0 };
  }

  // needs_review rows in ONE bounded read (contested rows are rare), grouped in TS.
  const { data: nrData, error: nrError } = await client
    .from("external_channel_listings")
    .select("storefront_key")
    .eq("mapping_status", "needs_review")
    .limit(NEEDS_REVIEW_CAP);
  if (!nrError && Array.isArray(nrData)) {
    for (const row of nrData) {
      const key = typeof (row as { storefront_key?: unknown }).storefront_key === "string" ? (row as { storefront_key: string }).storefront_key : null;
      if (key && ecl[key]) ecl[key] = { activeMapped: ecl[key]!.activeMapped, needsReview: ecl[key]!.needsReview + 1 };
    }
  } else {
    // needs_review read failed → do NOT claim 0; mark those storefronts UNKNOWN by
    // dropping the aggregate (only affects the ECL-identity storefronts).
    for (const key of ECL_GAP_STOREFRONTS) if (ecl[key]) ecl[key] = undefined;
  }

  return buildGapCounts({ productsTotal, variantsTotal, ecl, shopifyPresence });
}

export { STOREFRONTS };
