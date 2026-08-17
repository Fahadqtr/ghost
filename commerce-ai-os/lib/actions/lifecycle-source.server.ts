// OPS.8C — lifecycle Action Center source (SERVER-ONLY, read-only).
//
// Produces the per-product FACTS the pure lifecycle adapter turns into Action
// Center items. It reuses the CERTIFIED engines only — resolveLifecycleState
// (OPS.8A) + computeProductReadiness (UI.7.1) over the same product columns the
// operations read model uses. It is NOT a new heuristic scanner: it computes no
// time-based / sales-based inference — only the stored lifecycle_state and the
// certified readiness verdict. Best-effort: any failure yields null (the source
// reports ok:false and contributes zero actions, never a fabricated one).

import "server-only";

import { createClient } from "@/lib/supabase/server";
import { computeProductReadiness, isApproved } from "@/lib/operations/readiness/readiness";
import { mapProductRow } from "@/lib/operations/dashboard-view";
import { resolveLifecycleState, type LifecycleState } from "@/lib/lifecycle/state";

export interface LifecycleActionRow {
  productId: string;
  sku: string | null;
  name: string | null;
  /** stored lifecycle_state */
  lifecycleState: LifecycleState;
  /** derived READY: catalog-complete AND approved (readiness.readyToPublish) */
  ready: boolean;
  approved: boolean;
  readinessPercent: number;
}

const COLUMNS =
  "id, sku, barcode, name_ar, name_en, description_ar, description_en, brand_id, main_category, price, image_url, approval, platform_status, lifecycle_state";
const PAGE = 1000;
const MAX = 8000;

async function readAll(
  client: ReturnType<typeof createClient>,
  table: string,
  columns: string,
  orderCol: string,
): Promise<Record<string, unknown>[] | null> {
  const rows: Record<string, unknown>[] = [];
  for (let from = 0; from < MAX; from += PAGE) {
    const { data, error } = await client
      .from(table)
      .select(columns)
      .order(orderCol, { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) return null;
    if (!Array.isArray(data) || data.length === 0) break;
    rows.push(...(data as unknown as Record<string, unknown>[]));
    if (data.length < PAGE) break;
  }
  return rows;
}

/** Load the lifecycle facts for every live product. null on any read failure. */
export async function loadLifecycleActionRows(): Promise<LifecycleActionRow[] | null> {
  try {
    const client = createClient();
    const products = await readAll(client, "products", COLUMNS, "id");
    if (products === null) return null;

    const variantRows = await readAll(client, "product_variants", "parent_product_id", "parent_product_id");
    const variantCounts = new Map<string, number>();
    for (const v of variantRows ?? []) {
      const pid = (v as { parent_product_id?: unknown }).parent_product_id;
      if (typeof pid === "string") variantCounts.set(pid, (variantCounts.get(pid) ?? 0) + 1);
    }

    const out: LifecycleActionRow[] = [];
    for (const row of products) {
      const id = typeof row.id === "string" ? row.id : "";
      if (!id) continue;
      const product = mapProductRow(row, variantCounts.get(id) ?? 0);
      const readiness = computeProductReadiness(product);
      out.push({
        productId: id,
        sku: product.sku,
        name: product.nameAr ?? product.nameEn ?? product.sku,
        lifecycleState: resolveLifecycleState(row),
        ready: readiness.readyToPublish,
        approved: isApproved(product),
        readinessPercent: readiness.percent,
      });
    }
    return out;
  } catch {
    return null;
  }
}
