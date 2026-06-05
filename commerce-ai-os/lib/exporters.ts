// Pure CSV builders for per-channel exports (no DB, no I/O — easy to test).
// Phase 1: structure-only. Stock, images, and brand are intentionally left
// blank for now (filled in a later phase). Stock is never per-channel.

export interface ExportProduct {
  id: string;
  sku: string | null;
  snoonu_id: string | null;
  barcode: string | null;
  name_en: string | null;
  name_ar: string | null;
  main_category: string | null;
  sub_category: string | null;
  product_type: string | null;
  price: number | null;
  discount_price: number | null;
  image_url: string | null;
  description_en: string | null;
  description_ar: string | null;
  keywords_en: string | null;
  keywords_ar: string | null;
}

export interface ExportVariant {
  parent_product_id: string;
  variant_name: string | null;
  sku: string | null;
  price: number | null;
}

// product_id -> channel_status for the channel being exported
export type StatusMap = Record<string, string>;

// --- csv helpers -----------------------------------------------------------
const cell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export function toCsv(headers: string[], rows: unknown[][]): string {
  return [headers, ...rows].map((r) => r.map(cell).join(",")).join("\r\n");
}
const handle = (p: ExportProduct) =>
  (p.name_en ?? p.sku ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// --- 1) Shopify (product import format; one row per product) ---------------
export const SHOPIFY_HEADERS = [
  "Handle", "Title", "Body (HTML)", "Vendor", "Product Category", "Type",
  "Tags", "Published", "Variant SKU", "Variant Price", "Variant Inventory Qty",
  "Image Src",
];
export function buildShopifyCsv(products: ExportProduct[], status: StatusMap): string {
  const rows = products.map((p) => [
    handle(p), p.name_en, p.description_en, "" /*Vendor/brand later*/, p.main_category,
    p.product_type, p.keywords_en,
    status[p.id] === "Active" ? "TRUE" : "FALSE",
    p.sku, p.price, "" /*stock later*/, p.image_url ?? "",
  ]);
  return toCsv(SHOPIFY_HEADERS, rows);
}

// --- 2) Snoonu masterlist (one row per product; EN + AR) -------------------
export const SNOONU_HEADERS = [
  "Snoonu ID", "SKU", "Barcode", "Name EN", "Name AR", "Category", "Sub Category",
  "Price", "Discount Price", "Stock", "Snoonu Status", "Image URL",
  "Description EN", "Description AR", "Keywords EN", "Keywords AR",
];
export function buildSnoonuCsv(products: ExportProduct[], status: StatusMap): string {
  const rows = products.map((p) => [
    p.snoonu_id, p.sku, p.barcode, p.name_en, p.name_ar, p.main_category, p.sub_category,
    p.price, p.discount_price, "" /*stock later*/, status[p.id] ?? "Not Listed",
    p.image_url ?? "", p.description_en, p.description_ar, p.keywords_en, p.keywords_ar,
  ]);
  return toCsv(SNOONU_HEADERS, rows);
}

// --- 3) Talabat split-CSV (ONE ROW PER VARIANT; EN + AR) -------------------
export const TALABAT_HEADERS = [
  "Parent SKU", "Item Name EN", "Item Name AR", "Variant", "Item SKU", "Barcode",
  "Category", "Price", "Stock", "Talabat Status",
  "Description EN", "Description AR", "Keywords EN", "Keywords AR",
];
export function buildTalabatCsv(
  products: ExportProduct[],
  variants: ExportVariant[],
  status: StatusMap
): string {
  const byParent = new Map<string, ExportVariant[]>();
  for (const v of variants) {
    if (!byParent.has(v.parent_product_id)) byParent.set(v.parent_product_id, []);
    byParent.get(v.parent_product_id)!.push(v);
  }
  const suffix = (base: string | null, vn: string | null) =>
    `${base ?? ""}${vn ? " - " + vn : ""}`;
  const rows: unknown[][] = [];
  for (const p of products) {
    const vs = byParent.get(p.id) ?? [];
    const common = (vn: string | null, sku: string | null, price: number | null) => [
      p.sku, suffix(p.name_en, vn), suffix(p.name_ar, vn), vn ?? "", sku ?? p.sku,
      p.barcode, p.main_category, price ?? p.price, "" /*stock later*/,
      status[p.id] ?? "Not Listed", p.description_en, p.description_ar,
      p.keywords_en, p.keywords_ar,
    ];
    if (vs.length > 0) for (const v of vs) rows.push(common(v.variant_name, v.sku, v.price));
    else rows.push(common(null, p.sku, p.price));
  }
  return toCsv(TALABAT_HEADERS, rows);
}

// --- 4) Rafeeq (one row per product; EN + AR) ------------------------------
export const RAFEEQ_HEADERS = [
  "SKU", "Barcode", "Name EN", "Name AR", "Category", "Price", "Discount Price",
  "Stock", "Rafeeq Status", "Description EN", "Description AR", "Keywords EN", "Keywords AR",
];
export function buildRafeeqCsv(products: ExportProduct[], status: StatusMap): string {
  const rows = products.map((p) => [
    p.sku, p.barcode, p.name_en, p.name_ar, p.main_category, p.price,
    p.discount_price, "" /*stock later*/, status[p.id] ?? "Not Listed",
    p.description_en, p.description_ar, p.keywords_en, p.keywords_ar,
  ]);
  return toCsv(RAFEEQ_HEADERS, rows);
}

export const CHANNEL_KEYS = ["shopify", "snoonu", "talabat", "rafeeq"] as const;
export type ChannelKey = (typeof CHANNEL_KEYS)[number];

// Channel key -> the channel NAME(s) in the `channels` table.
export const CHANNEL_NAME: Record<ChannelKey, string> = {
  shopify: "Shopify",
  snoonu: "Snoonu",
  talabat: "Talabat",
  rafeeq: "Rafeeq",
};
