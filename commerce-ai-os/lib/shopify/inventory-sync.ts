import "server-only";
import { shopifyConfigured, fetchAllShopifyProducts, fetchPrimaryLocationId, setInventoryQuantities } from "./admin";
import { planInventorySync } from "@/lib/shopify-diff";

// Stock → Shopify sync core, shared by the manual button on /import-export/
// shopify-sync and the nightly availability cron. Our `inventory` table (plus
// product_variants quantities) is the source of truth; matched Shopify
// variants get their "available" quantity corrected at the primary location —
// so a product that runs out here shows sold-out on the store the same night.

export interface InventorySyncResult {
  ok: boolean;
  error?: string;
  matched: number;   // products found on Shopify
  unmatched: number; // ours with no Shopify match (need Phase-4 push)
  drift: number;     // quantities that differed
  updated: number;   // quantities actually written
  examples: string[]; // "Name: 5→0" style, first few
}

const EMPTY = { matched: 0, unmatched: 0, drift: 0, updated: 0, examples: [] as string[] };

async function pageAll<T>(fetchPage: (from: number, to: number) => any): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await fetchPage(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as T[]));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

export async function runShopifyInventorySync(sb: any): Promise<InventorySyncResult> {
  if (!shopifyConfigured()) return { ok: false, error: "شوبي فاي غير مربوط.", ...EMPTY };

  try {
    // Our stock per product = inventory rows + variant rows (variants optional).
    const [prods, invRows, varRows] = await Promise.all([
      pageAll<{ id: string; sku: string | null; name_en: string | null }>(
        (from, to) => sb.from("products").select("id, sku, name_en").range(from, to)),
      pageAll<{ product_id: string; stock_quantity: number | null }>(
        (from, to) => sb.from("inventory").select("product_id, stock_quantity").range(from, to)),
      pageAll<{ parent_product_id: string; stock_quantity: number | null }>(
        (from, to) => sb.from("product_variants").select("parent_product_id, stock_quantity").range(from, to))
        .catch(() => [] as { parent_product_id: string; stock_quantity: number | null }[]),
    ]);
    const stock = new Map<string, number>();
    for (const r of invRows) stock.set(r.product_id, (stock.get(r.product_id) ?? 0) + (Number(r.stock_quantity) || 0));
    for (const r of varRows) stock.set(r.parent_product_id, (stock.get(r.parent_product_id) ?? 0) + (Number(r.stock_quantity) || 0));
    const ours = prods.map((p) => ({ id: p.id, sku: p.sku, name_en: p.name_en, stock: stock.get(p.id) ?? 0 }));

    const remote = await fetchAllShopifyProducts();
    if (remote.error) return { ok: false, error: remote.error, ...EMPTY };

    const plan = planInventorySync(ours, remote.products ?? []);
    const examples = plan.changes.slice(0, 5).map((c) => `${c.name_en}: ${c.from ?? "؟"}←${c.quantity}`);
    if (!plan.changes.length) {
      return { ok: true, matched: plan.matched, unmatched: plan.unmatched, drift: 0, updated: 0, examples: [] };
    }

    const loc = await fetchPrimaryLocationId();
    if (loc.error || !loc.locationId) return { ok: false, error: loc.error ?? "location?", ...EMPTY, matched: plan.matched, unmatched: plan.unmatched, drift: plan.changes.length };

    const res = await setInventoryQuantities(loc.locationId, plan.changes);
    return {
      ok: res.ok, ...(res.error ? { error: res.error } : {}),
      matched: plan.matched, unmatched: plan.unmatched,
      drift: plan.changes.length, updated: res.updated, examples,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "sync failed", ...EMPTY };
  }
}
