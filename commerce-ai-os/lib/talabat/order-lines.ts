// Pure Talabat order-line parser + deterministic dedup key. NO Supabase, NO
// network, NO filesystem, NO DB writes — self-contained so node:test imports it
// directly. It keeps every identifier SEPARATE (channel product id vs SKU vs
// barcode) — nothing is collapsed into a single field — and never surfaces the
// raw payload, customer name, or phone.

export interface TalabatOrderLine {
  lineKey: string;                     // stable within this order (e.g. "line-0")
  channelProductId: string | null;    // vendor/remote product id from the channel
  sku: string | null;
  barcode: string | null;
  title: string | null;
  quantity: number;                    // positive integer when valid; 0 when invalid
  unitPrice: number | null;
  invalidQuantity: boolean;            // true when the raw qty was zero/negative/non-integer
}

export interface ParsedTalabatOrder {
  orderCode: string | null;
  lines: TalabatOrderLine[];
}

const s = (v: unknown): string => (v == null ? "" : String(v).trim());
const orNull = (v: unknown): string | null => { const t = s(v); return t === "" ? null : t; };

/** First present value across candidate keys (supports dotted "a.b" paths). */
function pick(obj: any, ...keys: string[]): unknown {
  for (const k of keys) {
    const v = k.includes(".") ? k.split(".").reduce((a: any, p) => (a == null ? a : a[p]), obj) : obj?.[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

/** Locate the line-items array wherever it lives. */
function findItems(o: any): any[] {
  const cands = [o?.items, o?.products, o?.orderItems, o?.lineItems, o?.order?.items, o?.order?.products, o?.basket?.items, o?.cart?.items];
  for (const c of cands) if (Array.isArray(c) && c.length) return c;
  return [];
}

/** A strictly-positive integer, else null (invalid). */
function positiveInt(v: unknown): number | null {
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
  return n;
}

function numOrNull(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse a Talabat/Delivery-Hero order payload into separate, structured lines.
 * Identifiers are kept apart: channelProductId (vendorProductId/productId/
 * product_id/remoteCode), sku (sku/code), barcode (barcode/ean/gtin). A missing
 * value is null; an invalid quantity is flagged (never silently defaulted to 1).
 */
export function parseTalabatOrderLines(payload: any): ParsedTalabatOrder {
  const o = payload && typeof payload === "object" ? payload : {};
  const order = o.order && typeof o.order === "object" ? o.order : o;

  const orderCode = orNull(pick(order, "code", "orderId", "order_id", "id", "token", "shortCode", "short_code", "orderCode"));

  const lines: TalabatOrderLine[] = findItems(order).map((it: any, i: number) => {
    const qty = positiveInt(pick(it, "quantity", "qty", "count"));
    return {
      lineKey: `line-${i}`,
      channelProductId: orNull(pick(it, "channelProductId", "vendorProductId", "productId", "product_id", "remoteCode", "remote_code")),
      sku: orNull(pick(it, "sku", "code")),
      barcode: orNull(pick(it, "barcode", "ean", "gtin")),
      title: orNull(pick(it, "name", "title", "productName", "product_name")),
      quantity: qty ?? 0,
      unitPrice: numOrNull(pick(it, "price", "unitPrice", "unit_price", "totalPrice", "amount", "paidPrice")),
      invalidQuantity: qty === null,
    };
  });

  return { orderCode, lines };
}

// ---- Deterministic dedup key -------------------------------------------------

/** Normalize an order code for the dedup key (trim + collapse whitespace). */
function normalizeOrderCode(code: string): string {
  return code.replace(/\s+/g, " ").trim();
}

/** Dependency-free 32-bit FNV-1a hash → 8-char hex. Deterministic, non-crypto. */
function fnv1aHex(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Build a deterministic dedup key. When a valid order code exists →
 * "talabat:<normalized-order-code>". Otherwise a stable hash over a CANONICAL
 * projection of the order (only the structured identifier fields + quantity),
 * sorted so JSON key order and line order never change it — but a genuinely
 * different order (different items/quantities) yields a different key. The raw
 * payload, customer name, and phone are NEVER part of the key.
 */
export function buildTalabatDedupKey(parsed: ParsedTalabatOrder): string {
  if (parsed.orderCode) {
    const norm = normalizeOrderCode(parsed.orderCode);
    if (norm !== "") return `talabat:${norm}`;
  }
  const canonicalLines = parsed.lines
    .map((l) => [l.channelProductId ?? "", l.sku ?? "", l.barcode ?? "", (l.title ?? "").toLowerCase(), l.quantity] as const)
    .map((t) => t.join(""))
    .sort(); // line order must not matter
  return `talabat:h:${fnv1aHex(canonicalLines.join(""))}`;
}
