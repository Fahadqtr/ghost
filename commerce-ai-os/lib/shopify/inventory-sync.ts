import "server-only";
import { shopifyConfigured, fetchAllShopifyProducts, fetchPrimaryLocationId, setInventoryQuantities, fetchRecentShopifyOrders } from "./admin";
import { planInventorySync } from "@/lib/shopify-diff";
import { planOrderDeductions, spreadDeduction, type CatalogRowLite } from "./order-deduct-compute";
import { logStockTransition } from "@/lib/tasks/stock-tasks";

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
  ordersProcessed?: number; // NEW store orders deducted from our stock this run
  deducted?: number;        // items subtracted
  ordersNote?: string;      // baseline / setup hints
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

/**
 * Deduct NEW store orders from the inventory table before the push, so a sale
 * on Shopify lowers OUR stock instead of being silently restocked at night.
 * shopify_synced_orders remembers what was already deducted; the very first
 * run only baselines existing orders without touching stock. Best-effort: any
 * failure (e.g. table not created yet) skips the step with a note.
 */
async function deductRecentOrders(
  sb: any,
  catalog: CatalogRowLite[],
): Promise<{ ordersProcessed: number; deducted: number; ordersNote?: string }> {
  const none = { ordersProcessed: 0, deducted: 0 };
  try {
    const since = new Date(Date.now() - 72 * 3600_000).toISOString();
    const { orders, error } = await fetchRecentShopifyOrders(since, 100);
    if (error) return { ...none, ordersNote: `تخطى خصم الطلبات: ${error}` };
    if (!orders?.length) return none;

    const { count, error: cntErr } = await sb
      .from("shopify_synced_orders")
      .select("order_id", { count: "exact", head: true });
    if (cntErr) return { ...none, ordersNote: "تخطى خصم الطلبات — شغّل supabase/shopify_synced_orders.sql مرة وحدة." };

    const { data: seen } = await sb
      .from("shopify_synced_orders")
      .select("order_id")
      .in("order_id", orders.map((o) => o.id));
    const alreadySynced = new Set<string>(((seen ?? []) as { order_id: string }[]).map((r) => r.order_id));

    const plan = planOrderDeductions(orders, catalog, alreadySynced);
    if (!plan.orderIds.length) return none;

    // First run: record the existing orders as the baseline, deduct nothing.
    const baseline = (count ?? 0) === 0;
    const nameOf = new Map(orders.map((o) => [o.id, o.name]));
    let deducted = 0;

    if (!baseline) {
      for (const d of plan.deductions) {
        const { data: rows, error: rowErr } = await sb
          .from("inventory")
          .select("id, stock_quantity")
          .eq("product_id", d.product_id);
        if (rowErr) continue;
        const rowStocks = ((rows ?? []) as { id: string | number; stock_quantity: number | null }[])
          .map((r) => ({ rowKey: r.id, stock: Number(r.stock_quantity) || 0 }));
        const updates = spreadDeduction(rowStocks, d.qty);
        let applied = 0; // what actually landed (clamped + write-checked)
        for (const u of updates) {
          const prev = rowStocks.find((r) => r.rowKey === u.rowKey)?.stock ?? 0;
          const { error: upErr } = await sb.from("inventory").update({ stock_quantity: u.stock }).eq("id", u.rowKey);
          if (!upErr) { deducted++; applied += prev - u.stock; }
        }
        // A store sale that empties the product opens the "mark unavailable on
        // the manual platforms" task (best-effort inside).
        if (applied > 0) {
          const beforeTotal = rowStocks.reduce((s, r) => s + r.stock, 0);
          await logStockTransition(sb, {
            productId: d.product_id, before: beforeTotal, after: beforeTotal - applied,
            actor: "شوبي فاي — طلب متجر",
          });
        }
      }
    }

    await sb.from("shopify_synced_orders").upsert(
      plan.orderIds.map((id) => ({ order_id: id, order_name: nameOf.get(id) ?? null, deducted: baseline ? 0 : deducted })),
      { onConflict: "order_id", ignoreDuplicates: true },
    );
    return {
      ordersProcessed: plan.orderIds.length,
      deducted,
      ...(baseline ? { ordersNote: "أول تشغيل — سجّل الطلبات الحالية كخط أساس بدون خصم." } : {}),
    };
  } catch (e) {
    return { ...none, ordersNote: `تخطى خصم الطلبات: ${e instanceof Error ? e.message : "خطأ"}` };
  }
}

export async function runShopifyInventorySync(sb: any): Promise<InventorySyncResult> {
  if (!shopifyConfigured()) return { ok: false, error: "شوبي فاي غير مربوط.", ...EMPTY };

  try {
    // Our stock per product = inventory rows + variant rows (variants optional).
    const [prods, invRows0, varRows] = await Promise.all([
      pageAll<{ id: string; sku: string | null; name_en: string | null }>(
        (from, to) => sb.from("products").select("id, sku, name_en").range(from, to)),
      pageAll<{ product_id: string; stock_quantity: number | null }>(
        (from, to) => sb.from("inventory").select("product_id, stock_quantity").range(from, to)),
      pageAll<{ parent_product_id: string; stock_quantity: number | null }>(
        (from, to) => sb.from("product_variants").select("parent_product_id, stock_quantity").range(from, to))
        .catch(() => [] as { parent_product_id: string; stock_quantity: number | null }[]),
    ]);

    // Store sales first: subtract new Shopify orders from our inventory, then
    // push the (now-correct) truth back to the store below.
    const orderStep = await deductRecentOrders(sb, prods);
    const invRows = orderStep.deducted
      ? await pageAll<{ product_id: string; stock_quantity: number | null }>(
          (from, to) => sb.from("inventory").select("product_id, stock_quantity").range(from, to))
      : invRows0;

    const stock = new Map<string, number>();
    for (const r of invRows) stock.set(r.product_id, (stock.get(r.product_id) ?? 0) + (Number(r.stock_quantity) || 0));
    for (const r of varRows) stock.set(r.parent_product_id, (stock.get(r.parent_product_id) ?? 0) + (Number(r.stock_quantity) || 0));
    const ours = prods.map((p) => ({ id: p.id, sku: p.sku, name_en: p.name_en, stock: stock.get(p.id) ?? 0 }));

    const remote = await fetchAllShopifyProducts();
    if (remote.error) return { ok: false, error: remote.error, ...EMPTY };

    const plan = planInventorySync(ours, remote.products ?? []);
    const examples = plan.changes.slice(0, 5).map((c) => `${c.name_en}: ${c.from ?? "؟"}←${c.quantity}`);
    if (!plan.changes.length) {
      return { ok: true, matched: plan.matched, unmatched: plan.unmatched, drift: 0, updated: 0, examples: [], ...orderStep };
    }

    const loc = await fetchPrimaryLocationId();
    if (loc.error || !loc.locationId) return { ok: false, error: loc.error ?? "location?", ...EMPTY, matched: plan.matched, unmatched: plan.unmatched, drift: plan.changes.length };

    const res = await setInventoryQuantities(loc.locationId, plan.changes);
    return {
      ok: res.ok, ...(res.error ? { error: res.error } : {}),
      matched: plan.matched, unmatched: plan.unmatched,
      drift: plan.changes.length, updated: res.updated, examples,
      ...orderStep,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "sync failed", ...EMPTY };
  }
}
