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

export interface OrderDeductionPlan {
  orderIds: string[];                                            // to mark as synced (all considered)
  deductions: { product_id: string; name_en: string; qty: number }[];
  unmatched: { title: string; qty: number }[];                   // items we couldn't map to the catalog
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

/**
 * Map new (not-yet-synced) orders' line items onto catalog products — by SKU
 * first, then by normalized title — and total the quantity to deduct per
 * product. Every considered order lands in orderIds so it is only ever
 * processed once, even when some of its items didn't match.
 */
export function planOrderDeductions(
  orders: OrderForDeduction[],
  catalog: CatalogRowLite[],
  alreadySynced: Set<string>,
): OrderDeductionPlan {
  const bySku = new Map<string, CatalogRowLite>();
  const byTitle = new Map<string, CatalogRowLite>();
  for (const c of catalog) {
    const k = key(c.sku);
    if (k && !bySku.has(k)) bySku.set(k, c);
    const t = key(c.name_en);
    if (t && !byTitle.has(t)) byTitle.set(t, c);
  }

  const orderIds: string[] = [];
  const considered: { id: string; name: string; paymentGatewayNames: string[] }[] = [];
  const perProduct = new Map<string, { product_id: string; name_en: string; qty: number }>();
  const unmatched: { title: string; qty: number }[] = [];

  for (const o of orders) {
    if (alreadySynced.has(o.id)) continue;
    orderIds.push(o.id);
    considered.push({ id: o.id, name: o.name, paymentGatewayNames: Array.isArray(o.paymentGatewayNames) ? o.paymentGatewayNames : [] });
    if (isVoidOrder(o)) continue;
    for (const it of o.items) {
      const qty = Math.max(0, Math.round(Number(it.qty) || 0));
      if (!qty) continue;
      const hit = (it.sku ? bySku.get(key(it.sku)) : undefined) ?? byTitle.get(key(it.title));
      if (!hit) { unmatched.push({ title: it.title, qty }); continue; }
      const agg = perProduct.get(hit.id) ?? { product_id: hit.id, name_en: String(hit.name_en ?? it.title), qty: 0 };
      agg.qty += qty;
      perProduct.set(hit.id, agg);
    }
  }

  return { orderIds, deductions: [...perProduct.values()], unmatched, considered };
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
