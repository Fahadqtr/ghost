// Pure, defensive parser for a Talabat / Delivery Hero order-webhook payload.
// The exact JSON schema is region-specific and undocumented publicly, so we read
// the common field names across the known variants and ALWAYS keep the raw
// payload alongside — nothing is lost, and mapping can be tightened once a real
// order is seen. DB/API-free so it can be unit-tested.

export interface TalabatOrderItem { sku: string; name: string; quantity: number; price: number }
export interface TalabatOrderParsed {
  orderId: string;
  status: string;
  items: TalabatOrderItem[];
  total: number | null;
  currency: string;
  customerName: string;
  placedAt: string | null;
}

const s = (v: unknown): string => (v == null ? "" : String(v).trim());
const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/** First non-empty value across candidate keys (supports "a.b" dotted paths). */
function pick(obj: any, ...keys: string[]): any {
  for (const k of keys) {
    const v = k.includes(".") ? k.split(".").reduce((a: any, p) => (a == null ? a : a[p]), obj) : obj?.[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

/** Locate the line-items array wherever it lives in the payload. */
function findItems(o: any): any[] {
  const cands = [o?.items, o?.products, o?.orderItems, o?.lineItems, o?.order?.items, o?.order?.products, o?.basket?.items, o?.cart?.items];
  for (const c of cands) if (Array.isArray(c) && c.length) return c;
  return [];
}

export function parseTalabatOrder(payload: any): TalabatOrderParsed {
  const o = payload && typeof payload === "object" ? payload : {};
  const order = o.order && typeof o.order === "object" ? o.order : o;

  const orderId = s(pick(order, "code", "orderId", "order_id", "id", "token", "shortCode", "short_code", "orderCode"));
  const status = s(pick(order, "status", "orderStatus", "state", "status.name", "deliveryStatus")) || "RECEIVED";

  const items: TalabatOrderItem[] = findItems(order).map((it: any) => ({
    sku: s(pick(it, "sku", "vendorProductId", "productId", "product_id", "remoteCode", "code", "barcode")),
    name: s(pick(it, "name", "title", "productName", "product_name")),
    quantity: num(pick(it, "quantity", "qty", "count")) || 1,
    price: num(pick(it, "price", "unitPrice", "unit_price", "totalPrice", "amount", "paidPrice")),
  }));

  const totalRaw = pick(order, "grandTotal", "totalValue", "total", "price.grandTotal", "price.totalNet", "amount", "totalAmount", "payment.total");
  const total = totalRaw === undefined ? null : num(totalRaw);
  const currency = s(pick(order, "currency", "currencyCode", "price.currency")) || "QAR";

  const customer = pick(order, "customer", "consumer") || {};
  const customerName = s(
    pick(customer, "name", "firstName", "first_name") ||
    [s(pick(customer, "firstName", "first_name")), s(pick(customer, "lastName", "last_name"))].filter(Boolean).join(" "),
  );

  const placedAt = s(pick(order, "createdAt", "created_at", "placedAt", "orderTime", "expiryDate", "preOrder.time")) || null;

  return { orderId, status, items, total, currency, customerName, placedAt };
}

/** A short human summary line for the orders list. */
export function orderSummary(p: TalabatOrderParsed): string {
  const n = p.items.reduce((a, i) => a + (i.quantity || 0), 0);
  const money = p.total != null ? ` · ${p.total} ${p.currency}` : "";
  return `${p.orderId || "—"} · ${p.status} · ${n} ${n === 1 ? "صنف" : "أصناف"}${money}`;
}
