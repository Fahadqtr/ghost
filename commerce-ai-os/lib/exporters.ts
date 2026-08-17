// INT.2F — Legacy export retirement.
//
// The legacy per-channel CSV/xlsx builders (the Shopify/Snoonu/Rafeeq CSV+AoA
// builders), their `ExportProduct` shape (which carried the legacy per-store
// identity fields) and the CHANNEL_KEYS/CHANNEL_NAME helpers have been REMOVED —
// the Export Center
// (/v2/export) is the sole export platform, and it reads identity from
// external_channel_listings, never from legacy columns.
//
// What remains here are the CERTIFIED, destination-agnostic TEMPLATE constants
// still consumed by the new Export Center pipeline (Snoonu + Rafeeq packages).
// This file is now pure template data — no builders, no I/O, no legacy identity.

// --- Snoonu masterlist header (consumed by the INT.2C Snoonu package) ----------
export const SNOONU_HEADERS = [
  "Snoonu ID", "SKU", "Barcode", "Name EN", "Name AR", "Category", "Sub Category",
  "Price", "Discount Price", "Stock", "Snoonu Status", "Image URL",
  "Description EN", "Description AR", "Keywords EN", "Keywords AR",
];

// --- Rafeeq template (consumed by the INT.2D Rafeeq package) --------------------
// English headers only, no subcategory; BARCODE + RAFEEQ ID columns. IMAGE NAME
// = SKU; RAFEEQ ID = the ECL external_product_id (or "new product" when unmapped).
export const RAFEEQ_HEADERS = [
  "CATEGORY - ENGLISH", "CATEGORY - ARABIC",
  "PRODUCT NAME - ENGLISH", "PRODUCT NAME - ARABIC", "PRICE",
  "DESCRIPTION - ENGLISH", "DESCRIPTION - ARABIC", "IMAGE NAME", "BARCODE", "RAFEEQ ID",
];

// Rafeeq's own categories (EN → {id, AR}), taken from a Rafeeq export. Used to
// fill the Arabic category name; unknown categories must be created in Rafeeq.
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

// Column widths (chars) for a tidy Rafeeq sheet (consumed by the Rafeeq xlsx serializer).
export const RAFEEQ_COL_WIDTHS = [22, 22, 34, 34, 8, 46, 46, 14, 18, 14];
