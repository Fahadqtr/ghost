// Shopify orders shaping — pure, DB-free (unit-tested).

export interface ShopifyOrderLite {
  id: string;
  name: string;          // "#1042"
  createdAt: string;     // ISO
  financial: string;     // PAID | PENDING | REFUNDED …
  fulfillment: string;   // FULFILLED | UNFULFILLED …
  total: number;
  currency: string;
  customer: string;      // display name ("" when guest)
  cancelledAt?: string | null;
  items: { title: string; qty: number; sku?: string }[];
  paymentGatewayNames?: string[]; // Shopify order.paymentGatewayNames (drives channel attribution)
  itemsTruncated?: boolean;       // true when the order had more line items than were fetched
}

/** Sales channel a Shopify order is attributed to. */
export type ShopifyOrderChannel = "talabat" | "shopify";

/**
 * Classify a Shopify order's channel PURELY from its payment gateway names.
 * A staff member records a Talabat order in Shopify POS with the custom payment
 * method "Talabat", so any gateway that (trimmed + lowercased) equals "talabat"
 * → "talabat"; anything else, an empty list, or null/undefined → "shopify".
 * Never uses product name, employee, or notes — payment method only.
 */
export function classifyShopifyOrderChannel(paymentGatewayNames: string[] | null | undefined): ShopifyOrderChannel {
  if (!Array.isArray(paymentGatewayNames)) return "shopify";
  for (const g of paymentGatewayNames) {
    if (typeof g === "string" && g.trim().toLowerCase() === "talabat") return "talabat";
  }
  return "shopify";
}

/** Count + revenue of a batch (revenue ignores unparsable totals). */
export function ordersSummary(orders: ShopifyOrderLite[]): { count: number; revenue: number } {
  let revenue = 0;
  for (const o of orders) if (Number.isFinite(o.total)) revenue += o.total;
  return { count: orders.length, revenue: Math.round(revenue * 100) / 100 };
}

/** Orders created within the last N hours (by createdAt). */
export function ordersWithin(orders: ShopifyOrderLite[], hours: number, now: Date): ShopifyOrderLite[] {
  const cutoff = now.getTime() - hours * 3600_000;
  return orders.filter((o) => {
    const t = new Date(o.createdAt).getTime();
    return Number.isFinite(t) && t >= cutoff;
  });
}

/** Best-selling products across a batch, by total quantity (desc). */
export function topProducts(
  orders: ShopifyOrderLite[],
  limit = 5,
): { title: string; sku?: string; qty: number; orders: number }[] {
  const m = new Map<string, { title: string; sku?: string; qty: number; orders: number }>();
  for (const o of orders) {
    for (const it of o.items ?? []) {
      const key = (it.sku && it.sku.trim()) || it.title || "—";
      const cur = m.get(key) ?? { title: it.title || key, sku: it.sku, qty: 0, orders: 0 };
      cur.qty += Number.isFinite(it.qty) ? it.qty : 0;
      cur.orders += 1;
      m.set(key, cur);
    }
  }
  return [...m.values()].sort((a, b) => b.qty - a.qty).slice(0, Math.max(1, limit));
}

/** One-line morning summary, or "" when there were no orders. */
export function morningOrdersLine(orders: ShopifyOrderLite[], now: Date): string {
  const day = ordersWithin(orders, 24, now);
  if (!day.length) return "";
  const { count, revenue } = ordersSummary(day);
  return `🛍️ ${count} طلب شوبي فاي خلال 24 ساعة — ${revenue.toFixed(0)} ر.ق`;
}
