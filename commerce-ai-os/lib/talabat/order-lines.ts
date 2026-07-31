import { createHash } from "node:crypto";

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
  event: string | null;               // safe, non-personal event/type
  reference: string | null;           // safe, merchant order reference
  createdAt: string | null;           // order timestamp
  lines: TalabatOrderLine[];
}

export type DedupConfidence = "strong" | "weak";
export interface TalabatDedupKey {
  key: string;
  confidence: DedupConfidence;
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

function findItems(o: any): any[] {
  const cands = [o?.items, o?.products, o?.orderItems, o?.lineItems, o?.order?.items, o?.order?.products, o?.basket?.items, o?.cart?.items];
  for (const c of cands) if (Array.isArray(c) && c.length) return c;
  return [];
}

/** A strictly-positive integer, else null (invalid) — no coercion/flooring. */
function positiveInt(v: unknown): number | null {
  if (typeof v === "boolean") return null;
  const n = typeof v === "number" ? v : Number(String(v).trim());
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
  const event = orNull(pick(o, "event", "eventType", "type") ?? pick(order, "event", "eventType", "type"));
  const reference = orNull(pick(order, "posOrderId", "pos_order_id", "externalId", "external_id", "reference", "order_reference", "merchantOrderId", "remoteOrderId"));
  const createdAt = orNull(pick(order, "createdAt", "created_at", "placedAt", "orderTime", "order_time"));

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

  return { orderCode, event, reference, createdAt, lines };
}

// ---- Deterministic dedup key -------------------------------------------------

/** Normalize an order code deterministically (trim + collapse + lowercase). */
function normalizeOrderCode(code: string): string {
  return code.replace(/\s+/g, " ").trim().toLowerCase();
}

/** SHA-256 hex (64 chars). Strong, collision-resistant — no 32-bit fallback. */
function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Build a deterministic dedup key + a confidence.
 *  - A valid order code → "talabat:<normalized-order-code>" (strong).
 *  - Otherwise a SHA-256 over a CANONICAL, non-personal projection of the order
 *    (event, merchant reference, created timestamp, and per-line identifiers +
 *    quantity + unit price), sorted so JSON key order and line order never
 *    change it. If a trusted per-order identifier (reference or createdAt)
 *    exists → strong; if only the cart is available (two independent orders with
 *    the same basket could collide) → WEAK.
 * The raw payload, customer name, phone, and address are NEVER part of the key.
 */
export function buildTalabatDedupKey(parsed: ParsedTalabatOrder): TalabatDedupKey {
  if (parsed.orderCode) {
    const norm = normalizeOrderCode(parsed.orderCode);
    if (norm !== "") return { key: `talabat:${norm}`, confidence: "strong" };
  }

  const canonicalLines = parsed.lines
    .map((l) => [l.channelProductId ?? "", l.sku ?? "", l.barcode ?? "", (l.title ?? "").toLowerCase(), String(l.quantity), l.unitPrice == null ? "" : String(l.unitPrice)].join(""))
    .sort(); // line order must not matter

  const canonical = JSON.stringify({
    event: parsed.event ?? "",
    reference: parsed.reference ?? "",
    createdAt: parsed.createdAt ?? "",
    lines: canonicalLines,
  });

  const hasTrustedId = Boolean(parsed.reference || parsed.createdAt);
  return { key: `talabat:h:${sha256Hex(canonical)}`, confidence: hasTrustedId ? "strong" : "weak" };
}
