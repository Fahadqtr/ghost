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
  image_filename: string | null;
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

// --- 3) Talabat split-CSV ---------------------------------------------------
// The Talabat format now lives in lib/malak/talabat-export.mjs (the SINGLE
// source shared by the in-app export button and scripts/export_talabat.mjs).
// See buildTalabatRows()/rowsToCsv() there.

// --- 4) Rafeeq — REAL platform import schema (40 columns, matches a Rafeeq
// PRODUCTS_DUMP export so the file imports straight back). EN + AR, images, and
// category id/arabic mapped from Rafeeq's own category list. ------------------
export const RAFEEQ_HEADERS = [
  "category_id", "category_name_english", "category_name_arabic", "category_status",
  "subcategory_id", "subcategory_name_english", "subcategory_name_arabic", "subcategory_status",
  "subsubcategory_id", "subsubcategory_name_english", "subsubcategory_name_arabic", "subsubcategory_status",
  "product_id", "product_name_english", "product_name_arabic",
  "product_description_english", "product_description_arabic",
  "product_status", "product_availability", "active", "product_price", "barcode", "pos_id",
  "product_preparation_time", "product_image", "groups", "group_id", "group_name_english",
  "group_name_arabic", "max_selection", "min_selection", "free_selection", "group_status",
  "group_sort_order", "group_design_type", "option_id", "option_name_english",
  "option_name_arabic", "option_price", "option_sort_order",
];

// Rafeeq's own categories (EN → {id, AR}), taken from a Rafeeq export. Lets the
// generated file carry the correct category_id + Arabic name for known
// categories; unknown (new) categories get a blank id and must be created in
// Rafeeq first.
export const RAFEEQ_CATEGORIES: Record<string, { id: number; ar: string }> = {
  "Masks": { id: 3708630, ar: "الأقنعة" },
  "Face Care": { id: 3708631, ar: "العناية بالوجه" },
  "Beauty Accessories": { id: 3708636, ar: "إكسسوارات الجمال" },
  "Hair Care": { id: 3708632, ar: "العناية بالشعر" },
  "Lashes & Nails": { id: 3708633, ar: "الرموش و الأظافر" },
  "Beauty Bundle": { id: 3708638, ar: "بـاقـة الجـمـال" },
  "Makeup": { id: 3708643, ar: "المكياج" },
  "Body Care": { id: 3708639, ar: "العناية بالجسم" },
  "Rhode Products Section": { id: 3708644, ar: "قسم منتجات رود - rhode" },
  "Sun Protection": { id: 3708634, ar: "الوقاية من الشمس" },
  "La Bobo Collection": { id: 3708635, ar: "✨ مجموعة لا بوبو | La Bobo Collection" },
  "Dental Care": { id: 3708640, ar: "العناية بالأسنان" },
  "Summer Essentials": { id: 3708645, ar: "مستلزمات الصيف" },
  "Electronics": { id: 3708641, ar: "إلكترونيات" },
  "Hand Care": { id: 3708642, ar: "العناية باليدين" },
};

export function buildRafeeqCsv(products: ExportProduct[], status: StatusMap): string {
  const rows = products.map((p) => {
    const cat = RAFEEQ_CATEGORIES[(p.main_category ?? "").trim()];
    const active = status[p.id] === "Active" ? 1 : 1; // export full catalog as listable
    return [
      cat?.id ?? "", p.main_category ?? "", cat?.ar ?? "", 1,           // category
      "", "ALL", "الكل", 1,                                            // subcategory
      "", "", "", "",                                                  // subsubcategory
      "", p.name_en ?? "", p.name_ar ?? "",                            // product id + names
      p.description_en ?? "", p.description_ar ?? "",                  // descriptions
      1, 1, active, p.price ?? "", p.sku ?? "", "",                    // status/price/barcode/pos
      15, p.image_url ?? "",                                           // prep time + image
      "", "", "", "", "", "", "", "", "", "",                          // groups
      "", "", "", "", "",                                              // options
    ];
  });
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
