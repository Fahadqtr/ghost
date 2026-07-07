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

/** One-line morning summary, or "" when there were no orders. */
export function morningOrdersLine(orders: ShopifyOrderLite[], now: Date): string {
  const day = ordersWithin(orders, 24, now);
  if (!day.length) return "";
  const { count, revenue } = ordersSummary(day);
  return `🛍️ ${count} طلب شوبي فاي خلال 24 ساعة — ${revenue.toFixed(0)} ر.ق`;
}
