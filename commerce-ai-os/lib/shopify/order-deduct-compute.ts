// Pure planning for "Shopify order → our inventory" deductions — DB-free,
// unit-tested. Self-contained (no cross-module imports) so the node test
// runner resolves it without path aliases.
//
// Why this exists: our inventory is the source of truth that the nightly sync
// PUSHES to Shopify. A store sale lowers Shopify's quantity only — unless we
// deduct it here first, the next sync would put the sold stock back.

export interface OrderItemLite {
  title: string;
  qty: number;
  sku?: string;
}

export interface OrderForDeduction {
  id: string;            // gid://shopify/Order/…
  name: string;          // "#1042"
  financial: string;     // PAID | REFUNDED | VOIDED …
  cancelledAt?: string | null;
  items: OrderItemLite[];
  paymentGatewayNames?: string[]; // carried through for channel attribution (does NOT affect deduction)
  itemsTruncated?: boolean;       // line-item data was paginated/cut off → fail closed (never processed)
}

export interface CatalogRowLite {
  id: string;
  sku: string | null;
  name_en: string | null;
}

// INV.5 — variant rows for grain-aware resolution. A product is "simple" when it
// has NO variant rows; otherwise it is a variant product and its parent inventory
// is Σ variants (never deducted directly by a channel sale).
export interface VariantRowLite {
  id: string;
  parent_product_id: string;
  sku: string | null;
  variant_name?: string | null;
}

// A durable, grain-aware deduction target. variantId=null → simple product;
// variantId set → a specific variant. SKU is NOT carried into the SQL sale.
export interface DeductionTarget {
  productId: string;
  variantId: string | null;
  name_en: string;
  qty: number;
}

export interface OrderDeductionPlan {
  orderIds: string[];                                            // to mark as synced (all considered)
  deductions: DeductionTarget[];
  unmatched: { title: string; qty: number }[];                   // items we couldn't map (or ambiguous) → block the order
  // Per considered (not-already-synced) order — carries the payment data so the
  // caller can persist channel attribution. Does NOT influence what is deducted.
  considered: { id: string; name: string; paymentGatewayNames: string[] }[];
}

const key = (v: unknown): string =>
  String(v ?? "").toLowerCase().normalize("NFKC").replace(/[’']/g, "").replace(/["،,.\-–—]/g, " ").replace(/\s+/g, " ").trim();

/** Orders that must never deduct stock (undone sales). */
export function isVoidOrder(o: Pick<OrderForDeduction, "financial" | "cancelledAt">): boolean {
  if (o.cancelledAt) return true;
  return /REFUNDED|VOIDED/i.test(o.financial);
}

type ResolvedTarget = { productId: string; variantId: string | null; name_en: string };

/**
 * INV.5 grain-aware line resolution. Priority:
 *   1. Exact UNIQUE variant SKU            → variant target.
 *   2. Exact UNIQUE simple-product SKU     → simple target (simple = no variants).
 *   3. Normalized title, UNIQUE simple only → simple target.
 * Everything else — a duplicate/ambiguous SKU, a variant-parent SKU that does not
 * resolve a specific option, a title that matches a variant parent, a duplicate
 * title, or no match — returns null → the line is unmatched and BLOCKS the order.
 * A variant product's parent inventory is NEVER deducted by a channel sale.
 */
function resolveLine(
  sku: string | undefined,
  title: string,
  maps: {
    variantBySku: Map<string, ResolvedTarget[]>;
    simpleBySku: Map<string, ResolvedTarget[]>;
    parentSku: Set<string>;
    simpleByTitle: Map<string, ResolvedTarget[]>;
  },
): ResolvedTarget | null {
  const s = key(sku);
  if (s) {
    const vs = maps.variantBySku.get(s);
    if (vs) return vs.length === 1 ? vs[0] : null;         // duplicate variant SKU → ambiguous → block
    const ps = maps.simpleBySku.get(s);
    if (ps) return ps.length === 1 ? ps[0] : null;         // duplicate simple SKU → block
    if (maps.parentSku.has(s)) return null;                // parent SKU on a variant product → cannot resolve option → block
    // SKU matched nothing → fall through to a title fallback.
  }
  const t = key(title);
  const ts = maps.simpleByTitle.get(t);
  if (ts && ts.length === 1) return ts[0];                 // unique simple title only
  return null;                                             // no match / ambiguous / variant-parent title → block
}

/**
 * Map new (not-yet-synced) orders' line items onto DURABLE grain-aware targets
 * (unique variant SKU → simple SKU → unique simple title) and total the quantity
 * per (product, variant). Every considered order lands in orderIds so it is only
 * processed once. An unresolved/ambiguous line becomes `unmatched` so the caller
 * blocks the whole order (all-or-nothing) — a variant product is never deducted
 * at the parent grain.
 */
export function planOrderDeductions(
  orders: OrderForDeduction[],
  catalog: CatalogRowLite[],
  variants: VariantRowLite[],
  alreadySynced: Set<string>,
): OrderDeductionPlan {
  const withVariants = new Set<string>();
  for (const v of variants) if (v.parent_product_id) withVariants.add(v.parent_product_id);

  const variantBySku = new Map<string, ResolvedTarget[]>();
  const parentSku = new Set<string>();
  const simpleBySku = new Map<string, ResolvedTarget[]>();
  const simpleByTitle = new Map<string, ResolvedTarget[]>();

  const push = (m: Map<string, ResolvedTarget[]>, k: string, v: ResolvedTarget) => {
    const arr = m.get(k); if (arr) arr.push(v); else m.set(k, [v]);
  };

  for (const v of variants) {
    const k = key(v.sku);
    if (!k) continue;
    push(variantBySku, k, { productId: v.parent_product_id, variantId: v.id, name_en: String(v.variant_name ?? "") });
  }
  for (const c of catalog) {
    const isSimple = !withVariants.has(c.id);
    const sk = key(c.sku);
    if (sk) {
      if (isSimple) push(simpleBySku, sk, { productId: c.id, variantId: null, name_en: String(c.name_en ?? "") });
      else parentSku.add(sk);
    }
    if (isSimple) {
      const t = key(c.name_en);
      if (t) push(simpleByTitle, t, { productId: c.id, variantId: null, name_en: String(c.name_en ?? "") });
    }
  }
  const maps = { variantBySku, simpleBySku, parentSku, simpleByTitle };

  const orderIds: string[] = [];
  const considered: { id: string; name: string; paymentGatewayNames: string[] }[] = [];
  const perTarget = new Map<string, DeductionTarget>();
  const unmatched: { title: string; qty: number }[] = [];

  for (const o of orders) {
    if (alreadySynced.has(o.id)) continue;
    orderIds.push(o.id);
    considered.push({ id: o.id, name: o.name, paymentGatewayNames: Array.isArray(o.paymentGatewayNames) ? o.paymentGatewayNames : [] });
    if (isVoidOrder(o)) continue;
    for (const it of o.items) {
      const qty = Math.max(0, Math.round(Number(it.qty) || 0));
      if (!qty) continue;
      const hit = resolveLine(it.sku, it.title, maps);
      if (!hit) { unmatched.push({ title: it.title, qty }); continue; }
      const key2 = `${hit.productId}|${hit.variantId ?? ""}`;
      const agg = perTarget.get(key2) ?? { productId: hit.productId, variantId: hit.variantId, name_en: hit.name_en || it.title, qty: 0 };
      agg.qty += qty;
      perTarget.set(key2, agg);
    }
  }

  return { orderIds, deductions: [...perTarget.values()], unmatched, considered };
}

/**
 * Spread one product's deduction across its inventory rows, biggest first,
 * never below zero. Returns the rows that must be written back.
 */
export function spreadDeduction(
  rows: { rowKey: string | number; stock: number }[],
  qty: number,
): { rowKey: string | number; stock: number }[] {
  const updates: { rowKey: string | number; stock: number }[] = [];
  let remaining = Math.max(0, Math.round(qty));
  for (const r of [...rows].sort((a, b) => b.stock - a.stock)) {
    if (remaining <= 0) break;
    const have = Math.max(0, Math.round(Number(r.stock) || 0));
    if (!have) continue;
    const take = Math.min(have, remaining);
    updates.push({ rowKey: r.rowKey, stock: have - take });
    remaining -= take;
  }
  return updates;
}
