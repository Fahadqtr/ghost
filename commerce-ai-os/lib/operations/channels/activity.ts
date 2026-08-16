// OPS.4 — Cross-channel activity read model (PURE).
//
// Normalizes REAL recorded events from existing reliable sources (the malak_audit
// ledger + talabat_orders + per-channel snapshot freshness) into one uniform feed.
// It creates NO new write-side event ledger and NEVER synthesizes activity — a row
// exists here only because a source already recorded it (§3). All shaping is pure;
// the server reader does the bounded IO and hands rows here.
//
// PURE: no imports. node:test loads it directly.

export type ActivitySource = "audit" | "talabat" | "snapshot";
export type ActivityStatus = "ok" | "warning" | "error" | "info";

export interface ActivityEvent {
  id: string;
  timestamp: string; //   ISO
  channel: string; //     shopify | snoonu | talabat | rafeeq | internal
  storefront: string | null;
  eventType: string; //   normalized event key (audit action_type / talabat_order / snapshot)
  ref: string | null; //  product id / sku / order code
  summary: string;
  status: ActivityStatus;
  source: ActivitySource;
  link: string; //        an EXISTING route (deep link)
}

// ── raw source shapes (structural subsets) ──────────────────────────────────────
export interface AuditRawRow {
  id?: unknown;
  created_at?: unknown;
  action_type?: unknown;
  agent?: unknown;
  sku?: unknown;
  product_id?: unknown;
  field?: unknown;
  old_value?: unknown;
  new_value?: unknown;
  details?: unknown;
  status?: unknown;
}

export interface TalabatOrderRawRow {
  id?: unknown;
  order_code?: unknown;
  received_at?: unknown;
  status?: unknown;
  processing_status?: unknown;
}

const s = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

/** Known audit action_types → Arabic labels (unknown types fall back to the raw key). */
export const ACTIVITY_EVENT_LABEL: Record<string, string> = {
  set_price: "تعديل سعر",
  update_stock: "تعديل مخزون",
  set_approval: "اعتماد منتج",
  add_product: "إضافة منتج",
  stock_in: "إدخال مخزون",
  stock_out: "إخراج مخزون (بيع)",
  stocktake: "جرد",
  variant_stock_in: "إدخال مخزون متغيّر",
  variant_stock_out: "إخراج مخزون متغيّر",
  product_edit_stock: "تعديل مخزون (محرّر)",
  product_edit_variant_stock: "تعديل مخزون متغيّر (محرّر)",
  catalog_enrich: "إثراء ذكي",
  barcode_complete: "إكمال باركود",
  availability_sync_apply: "مزامنة توفّر",
  talabat_order: "طلب طلبات",
};

const ROUTES = {
  channels: "/v2/operations/channels",
  catalog: "/v2/catalog",
  operations: "/v2/operations",
  missingProducts: "/v2/operations/missing-products",
  media: "/v2/operations/media",
  aiEnrichment: "/v2/operations/ai-enrichment",
  barcodeCompletion: "/v2/operations/barcode-completion",
  availabilitySync: "/v2/operations/availability-sync",
} as const;

/** Deterministic deep link for an event (an EXISTING route only). Product-detail
 *  deep-linking (from `ref`) is left to the UI; this returns the owning workflow. */
export function activityLink(eventType: string, _channel?: string): string {
  if (eventType === "availability_sync_apply") return ROUTES.availabilitySync;
  if (eventType === "barcode_complete") return ROUTES.barcodeCompletion;
  if (eventType === "catalog_enrich") return ROUTES.aiEnrichment;
  if (eventType.startsWith("ch6f_")) return ROUTES.missingProducts;
  if (eventType === "talabat_order") return `${ROUTES.channels}?channel=talabat`;
  if (eventType.includes("stock") || eventType === "set_price" || eventType === "set_approval" || eventType === "add_product" || eventType.startsWith("product_edit")) {
    return ROUTES.catalog;
  }
  return ROUTES.channels;
}

function auditStatus(raw: string | null): ActivityStatus {
  switch (raw) {
    case "committed":
    case "done":
      return "ok";
    case "committed_over_band":
      return "warning";
    case "failed":
      return "error";
    default:
      return "info";
  }
}

function auditChannelStorefront(details: unknown): { channel: string; storefront: string | null } {
  if (details && typeof details === "object") {
    const d = details as Record<string, unknown>;
    const storefront = s(d.storefront);
    const channel = s(d.channel) ?? (storefront ? storefront.slice(0, storefront.indexOf(":")) || null : null) ?? s(d.source);
    if (channel || storefront) return { channel: channel ?? "internal", storefront };
  }
  return { channel: "internal", storefront: null };
}

function auditSummary(row: AuditRawRow): string {
  const label = ACTIVITY_EVENT_LABEL[s(row.action_type) ?? ""] ?? (s(row.action_type) ?? "حدث");
  const sku = s(row.sku);
  const field = s(row.field);
  const oldV = s(row.old_value);
  const newV = s(row.new_value);
  const parts: string[] = [label];
  if (sku) parts.push(sku);
  if (field && (oldV || newV)) parts.push(`${field}: ${oldV ?? "—"} → ${newV ?? "—"}`);
  return parts.join(" · ");
}

/** Normalize one malak_audit row. Returns null when it carries no usable timestamp. */
export function normalizeAuditRow(row: AuditRawRow): ActivityEvent | null {
  const timestamp = s(row.created_at);
  const eventType = s(row.action_type);
  if (!timestamp || !eventType) return null;
  const { channel, storefront } = auditChannelStorefront(row.details);
  const ref = s(row.product_id) ?? s(row.sku);
  return {
    id: s(row.id) ?? `${eventType}:${timestamp}`,
    timestamp,
    channel,
    storefront,
    eventType,
    ref,
    summary: auditSummary(row),
    status: auditStatus(s(row.status)),
    source: "audit",
    link: activityLink(eventType, channel),
  };
}

function talabatStatus(orderStatus: string | null, processing: string | null): ActivityStatus {
  if (processing === "failed") return "error";
  if (processing === "manual_review") return "warning";
  if (orderStatus === "CANCELED") return "warning";
  if (orderStatus === "DELIVERED" || processing === "processed") return "ok";
  return "info";
}

/** Normalize one talabat_orders row. Returns null without a usable timestamp. */
export function normalizeTalabatOrder(row: TalabatOrderRawRow): ActivityEvent | null {
  const timestamp = s(row.received_at);
  if (!timestamp) return null;
  const code = s(row.order_code);
  const orderStatus = s(row.status);
  const processing = s(row.processing_status);
  return {
    id: s(row.id) ?? `talabat_order:${code ?? timestamp}`,
    timestamp,
    channel: "talabat",
    storefront: "talabat:malikas",
    eventType: "talabat_order",
    ref: code,
    summary: `${ACTIVITY_EVENT_LABEL.talabat_order}${code ? ` ${code}` : ""}${orderStatus ? ` · ${orderStatus}` : ""}`,
    status: talabatStatus(orderStatus, processing),
    source: "talabat",
    link: activityLink("talabat_order", "talabat"),
  };
}

// ── merge / sort / filter (bounded) ─────────────────────────────────────────────
export function sortActivity(events: readonly ActivityEvent[]): ActivityEvent[] {
  return [...events].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

export function mergeActivity(groups: readonly (readonly ActivityEvent[])[], limit: number): ActivityEvent[] {
  const all: ActivityEvent[] = [];
  for (const g of groups) for (const e of g) all.push(e);
  return sortActivity(all).slice(0, Math.max(0, limit));
}

export interface ActivityFilters {
  channel: string | null;
  storefront: string | null;
  eventType: string | null;
  status: ActivityStatus | null;
}

export const EMPTY_ACTIVITY_FILTERS: ActivityFilters = { channel: null, storefront: null, eventType: null, status: null };

export function filterActivity(events: readonly ActivityEvent[], f: ActivityFilters): ActivityEvent[] {
  return events.filter((e) => {
    if (f.channel && e.channel !== f.channel) return false;
    if (f.storefront && e.storefront !== f.storefront) return false;
    if (f.eventType && e.eventType !== f.eventType) return false;
    if (f.status && e.status !== f.status) return false;
    return true;
  });
}

const ACTIVITY_STATUSES: readonly ActivityStatus[] = ["ok", "warning", "error", "info"];

const one = (v: unknown): string | null => {
  const x = Array.isArray(v) ? v[0] : v;
  return typeof x === "string" && x.trim() !== "" ? x.trim() : null;
};

/** Parse activity filters from a Next searchParams object (prefixed `a_`). Pure;
 *  unknown status falls back to null (never throws). */
export function parseActivityFilters(params: Record<string, unknown>): ActivityFilters {
  const status = one(params.a_status);
  return {
    channel: one(params.a_channel),
    storefront: one(params.a_storefront),
    eventType: one(params.a_event),
    status: status && (ACTIVITY_STATUSES as readonly string[]).includes(status) ? (status as ActivityStatus) : null,
  };
}
