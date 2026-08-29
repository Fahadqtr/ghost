import "server-only";
import { shopifyConfigured, fetchAllShopifyProducts, fetchPrimaryLocationId, setInventoryQuantities, fetchRecentShopifyOrders } from "./admin";
import { planInventorySync } from "@/lib/shopify-diff";
import { planOrderDeductions, type CatalogRowLite, type VariantRowLite } from "./order-deduct-compute";
import { classifyShopifyOrderChannel } from "./orders-compute";
import { claimAndDeduct, syncCanPush, type ClaimDeductPorts, type ClaimDeductPlanners, type BlockedReason } from "./order-ledger";
import { logAuthoritativeStockTransition, logAuthoritativeVariantOnlyTransition } from "@/lib/inventory/transition";
import { shopifyOosZeroPushList } from "@/lib/availability/channel-policy";
import { pushVariantInventoryToShopify } from "./admin";
import { planInventoryGrainBatch, type VariantInventorySummary } from "./variant-inventory";
import { loadCanonicalInventoryInputs } from "./canonical-inventory.server";

const SHOPIFY_ORDER_ACTOR = "شوبي فاي — طلب متجر";
/** A zero crossing in either direction (matches planStockTransition's <=0 threshold). */
const crossedZero = (before: number, after: number): boolean =>
  (before > 0 && after <= 0) || (before <= 0 && after > 0);

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
 * shopify_synced_orders is the idempotency ledger; the very first run only
 * baselines existing orders without touching stock.
 *
 * Safety: this is a thin adapter around order-ledger's TRANSACTIONAL contract.
 * The idempotency claim, ALL inventory deductions, and the ledger completion for
 * an order happen inside ONE Postgres transaction (the process_shopify_order_
 * deduction RPC), so a store sale is never subtracted unless its order is
 * durably recorded, the same order can never be deducted twice (partial failure
 * OR concurrent run), and a partial failure rolls back the claim AND the stock
 * together. This module does NO direct inventory writes on this path; it fails
 * closed — nothing is deducted unless the RPC explicitly reports success.
 */
/** A safe, non-raw note for each way the order step can block the Shopify push. */
function safeBlockNote(reason?: BlockedReason): string {
  switch (reason) {
    case "migration_required":
      return "تخطى مزامنة المخزون — required migration: شغّل supabase/shopify_synced_orders_deduction.sql مرة واحدة.";
    case "orders_truncated":
      return "تخطى مزامنة المخزون — طلبات المتجر أكثر من أن تُقرأ دفعة واحدة (سيُعاد المحاولة).";
    case "line_items_truncated":
      return "تخطى مزامنة المخزون — أصناف أحد الطلبات غير مكتملة القراءة (سيُعاد المحاولة).";
    case "unmatched_order":
      return "تخطى مزامنة المخزون — طلب فيه صنف غير مطابق للكتالوج (يلزم مطابقة يدوية).";
    case "db_error":
      return "تخطى مزامنة المخزون — خطأ قاعدة بيانات مؤقت (سيُعاد المحاولة).";
    case "unknown_response":
      return "تخطى مزامنة المخزون — استجابة غير متوقعة من قاعدة البيانات (سيُعاد المحاولة).";
    default:
      return "تخطى مزامنة المخزون — لم تكتمل تسوية الطلبات (سيُعاد المحاولة).";
  }
}

/** The order step's result surfaced to runShopifyInventorySync. `complete=false`
 *  BLOCKS the Shopify stock push for this run (see the module header). `deducted`
 *  is always truthful — it counts only rows the RPC actually committed. */
interface OrderStep {
  complete: boolean;
  ordersProcessed: number;
  deducted: number;
  ordersNote?: string;
}

async function deductRecentOrders(sb: any, catalog: CatalogRowLite[], variants: VariantRowLite[]): Promise<OrderStep> {
  const none = { ordersProcessed: 0, deducted: 0 };
  try {
    const since = new Date(Date.now() - 72 * 3600_000).toISOString();
    // Pull the whole 72h window (paginated); a high cap so `complete` only trips on
    // extreme volume. A truncated fetch (complete=false) blocks the push below.
    const { orders, error, complete: fetchComplete } = await fetchRecentShopifyOrders(since, 1000);
    if (error) return { complete: false, ...none, ordersNote: safeBlockNote("db_error") };
    if (!orders?.length) return { complete: true, ...none };

    const { count, error: cntErr } = await sb
      .from("shopify_synced_orders")
      .select("order_id", { count: "exact", head: true });
    if (cntErr) return { complete: false, ...none, ordersNote: safeBlockNote("migration_required") };

    const { data: seen } = await sb
      .from("shopify_synced_orders")
      .select("order_id")
      .in("order_id", orders.map((o) => o.id));
    const alreadySynced = new Set<string>(((seen ?? []) as { order_id: string }[]).map((r) => r.order_id));

    // First run (empty ledger): record existing orders as the baseline, deduct nothing.
    const baseline = (count ?? 0) === 0;
    const nameOf = new Map<string, string>(orders.map((o) => [o.id, o.name]));

    // Supabase-backed ports. The deduction RPC is the sole writer of the ledger AND
    // inventory (one transaction); TypeScript never writes inventory on this path.
    const ports: ClaimDeductPorts = {
      callDeduction: (args) =>
        sb.rpc("process_shopify_order_deduction", {
          p_order_id: args.p_order_id,
          p_order_name: args.p_order_name,
          p_channel: args.p_channel,
          p_payment_gateway_names: args.p_payment_gateway_names,
          p_deductions: args.p_deductions,
          p_baseline: args.p_baseline,
        }),
      // INV.5 — authoritative transitions from the sale RPC's before/after. Parent
      // task once per product; a variant-only task only when its parent did NOT
      // cross zero (no duplicate parent tasks). Best-effort; no inventory write.
      logTransitions: async ({ products, variants: vChanges }) => {
        const parentCrossed = new Map<string, boolean>();
        for (const p of products) {
          const before = Number(p.before) || 0;
          const after = Number(p.after) || 0;
          parentCrossed.set(p.productId, crossedZero(before, after));
          await logAuthoritativeStockTransition(sb, { productId: p.productId, before, after, actor: SHOPIFY_ORDER_ACTOR });
        }
        for (const v of vChanges) {
          if (parentCrossed.get(v.productId)) continue; // parent task already covers it
          await logAuthoritativeVariantOnlyTransition(sb, {
            productId: v.productId,
            variantId: v.variantId,
            variantName: v.variantSku ?? "",
            variantBefore: Number(v.before) || 0,
            variantAfter: Number(v.after) || 0,
            actor: SHOPIFY_ORDER_ACTOR,
          });
        }
      },
    };
    const planners: ClaimDeductPlanners = {
      plan: (o, c, seen) => planOrderDeductions(o, c, variants, seen),
      classifyChannel: classifyShopifyOrderChannel,
    };

    const res = await claimAndDeduct(orders, catalog, alreadySynced, baseline, nameOf, ports, planners, fetchComplete !== false);
    return {
      complete: res.complete,
      ordersProcessed: res.processed,
      deducted: res.deducted,
      ...(res.complete ? (res.note ? { ordersNote: res.note } : {}) : { ordersNote: safeBlockNote(res.blockedReason) }),
    };
  } catch {
    // No raw error text ever surfaced. Fail closed → block the push.
    return { complete: false, ...none, ordersNote: safeBlockNote() };
  }
}

export async function runShopifyInventorySync(sb: any): Promise<InventorySyncResult> {
  if (!shopifyConfigured()) return { ok: false, error: "شوبي فاي غير مربوط.", ...EMPTY };

  try {
    // Product catalog + EXPLICIT availability (products.stock_status). The order
    // step needs the full catalog to match store orders; the push list is derived
    // from availability only (below).
    const prods = await pageAll<{ id: string; sku: string | null; name_en: string | null; stock_status: string | null }>(
      (from, to) => sb.from("products").select("id, sku, name_en, stock_status").range(from, to));

    // INV.5 — variant rows for grain-aware order matching (a variant product's
    // parent inventory is never deducted directly by a store sale).
    const variants = await pageAll<VariantRowLite>(
      (from, to) => sb.from("product_variants").select("id, parent_product_id, sku, variant_name").range(from, to));

    // Store sales first: subtract new Shopify orders from our inventory via the
    // transactional deduction RPC (preserved — this is real sales, not
    // availability). This is the only inventory write on this path.
    const orderStep = await deductRecentOrders(sb, prods, variants);

    // FAIL CLOSED: if the order step did not fully settle (RPC error, missing
    // migration, null/unknown response, an unmatched order line, or truncated
    // Shopify data) we must NOT push to Shopify — a partial view would re-raise
    // sold-out stock. Skip the location fetch and the push entirely.
    if (!syncCanPush(orderStep)) {
      return {
        ok: false,
        error: orderStep.ordersNote ?? safeBlockNote(),
        ...EMPTY,
        ordersProcessed: orderStep.ordersProcessed,
        deducted: orderStep.deducted,
        ...(orderStep.ordersNote ? { ordersNote: orderStep.ordersNote } : {}),
      };
    }

    // INV.2D — availability-based, NON-DESTRUCTIVE push (shared pure helper). Only
    // OutOfStock products are pushed (to external quantity 0); In-Stock products
    // are NEVER overwritten with a local quantity this phase (physical counts are
    // not yet trusted), and no local quantity is ever written to represent it.
    const oosAll = shopifyOosZeroPushList(prods);

    // GRAIN SPLIT (INV.6). A canonical product with variants must NEVER be
    // resolved by its bare product SKU here: that SKU exists on Shopify only on
    // an unmapped LEGACY twin, so the zero would land on the wrong product and
    // on just one of its variants. Those products go through the exact
    // ECL-mapped variant GIDs instead, and every mapped variant is zeroed.
    // Business scope is unchanged — still zeros only, still only for products
    // our availability says are Out of Stock.
    const variantParents = new Set<string>();
    for (const v of variants) if (v.parent_product_id) variantParents.add(v.parent_product_id);
    const ours = oosAll.filter((o) => !variantParents.has(o.id));
    const variantOosIds = oosAll.filter((o) => variantParents.has(o.id)).map((o) => o.id);

    let variantSummary: VariantInventorySummary | null = null;
    if (variantOosIds.length) {
      const inputs = await loadCanonicalInventoryInputs(sb, variantOosIds);
      variantSummary = await pushVariantInventoryToShopify(planInventoryGrainBatch(inputs, "ZERO"));
    }

    const remote = await fetchAllShopifyProducts();
    if (remote.error) return { ok: false, error: remote.error, ...EMPTY };

    const plan = planInventorySync(ours, remote.products ?? []);
    // Variant-grain products are counted alongside the simple ones so the UI
    // total reflects every zero actually written, not just the SKU-matched half.
    const vMatched = variantSummary?.synced ?? 0;
    const vUnmatched = variantSummary?.blocked ?? 0;
    const vWritten = variantSummary?.variantsWritten ?? 0;
    const examples = plan.changes.slice(0, 5).map((c) => `${c.name_en}: ${c.from ?? "؟"}←${c.quantity}`);
    if (!plan.changes.length) {
      return {
        ok: true, matched: plan.matched + vMatched, unmatched: plan.unmatched + vUnmatched,
        drift: vWritten, updated: vWritten, examples: [], ...orderStep,
      };
    }

    const loc = await fetchPrimaryLocationId();
    if (loc.error || !loc.locationId) return { ok: false, error: loc.error ?? "location?", ...EMPTY, matched: plan.matched + vMatched, unmatched: plan.unmatched + vUnmatched, drift: plan.changes.length + vWritten };

    const res = await setInventoryQuantities(loc.locationId, plan.changes);
    return {
      ok: res.ok, ...(res.error ? { error: res.error } : {}),
      matched: plan.matched + vMatched, unmatched: plan.unmatched + vUnmatched,
      drift: plan.changes.length + vWritten, updated: res.updated + vWritten, examples,
      ...orderStep,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "sync failed", ...EMPTY };
  }
}
