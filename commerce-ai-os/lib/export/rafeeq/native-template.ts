// RAFEEQ NATIVE TEMPLATE — the audited real Rafeeq workbook contract (PURE).
//
// Source of truth: the owner-supplied real Rafeeq workbook (products dump,
// worksheet "data", 40 columns). Audited on 2026-08-25 directly from the file:
//   • ONE worksheet named "data"; exactly 40 headers in a fixed order (below).
//   • A SIMPLE product is ONE physical row with groups = 0 and every
//     group/option cell blank.
//   • A product WITH options is represented by REPEATED physical rows — one per
//     option — sharing IDENTICAL parent product fields (same product_id, name,
//     description, price, barcode, image) and groups = 1; ONLY the group/option
//     cells vary. Verified across every multi-row product in the workbook: zero
//     parent-field differences, exactly ONE distinct group per product.
//   • The BARCODE column carries the canonical parent SKU (e.g. "mk175") — the
//     approved PR #677 rule, confirmed live in the workbook.
//   • product_image holds Rafeeq-GENERATED asset JSON for existing records — it
//     cannot be fabricated for new records. Our packages reference the packaged
//     parent image FILENAME (the certified exchange convention); images ship
//     once per product, never duplicated per option.
//   • IDs (product_id / group_id / option_id) in the workbook are all
//     Rafeeq-generated integers; the dump proves no blank-ID convention for new
//     records. New records are emitted with BLANK ids (never invented numbers);
//     an existing resolved ECL identity fills product_id.
//   • option_price (OWNER-APPROVED rule, matching the live-store convention):
//     options at ONE identical effective price ⇒ product_price = that uniform
//     price and option_price = 0; options at DIFFERING effective prices ⇒
//     product_price = the literal "PRICE ON SELECTION" and option_price = the
//     FULL effective canonical price of each option — NEVER a delta. The only
//     pricing blocker is an option with no valid effective price alongside
//     priced siblings (its full price cannot be emitted).
//
// DO NOT add, remove, rename, or reorder headers — the workbook is the contract.
// No I/O — node:test loads this directly.

/** The exact 40 workbook headers, in the exact audited order. */
export const RAFEEQ_NATIVE_HEADERS = [
  "category_id",
  "category_name_english",
  "category_name_arabic",
  "category_status",
  "subcategory_id",
  "subcategory_name_english",
  "subcategory_name_arabic",
  "subcategory_status",
  "subsubcategory_id",
  "subsubcategory_name_english",
  "subsubcategory_name_arabic",
  "subsubcategory_status",
  "product_id",
  "product_name_english",
  "product_name_arabic",
  "product_description_english",
  "product_description_arabic",
  "product_status",
  "product_availability",
  "active",
  "product_price",
  "barcode",
  "pos_id",
  "product_preparation_time",
  "product_image",
  "groups",
  "group_id",
  "group_name_english",
  "group_name_arabic",
  "max_selection",
  "min_selection",
  "free_selection",
  "group_status",
  "group_sort_order",
  "group_design_type",
  "option_id",
  "option_name_english",
  "option_name_arabic",
  "option_price",
  "option_sort_order",
] as const;

/** The audited worksheet name. */
export const RAFEEQ_NATIVE_SHEET = "data";

/** Column indexes (0-based) into RAFEEQ_NATIVE_HEADERS — single source. */
export const NATIVE_COL = {
  categoryId: 0,
  categoryNameEn: 1,
  categoryNameAr: 2,
  categoryStatus: 3,
  subcategoryId: 4,
  subcategoryNameEn: 5,
  subcategoryNameAr: 6,
  subcategoryStatus: 7,
  productId: 12,
  productNameEn: 13,
  productNameAr: 14,
  productDescriptionEn: 15,
  productDescriptionAr: 16,
  productStatus: 17,
  productAvailability: 18,
  active: 19,
  productPrice: 20,
  barcode: 21,
  posId: 22,
  preparationTime: 23,
  productImage: 24,
  groups: 25,
  groupId: 26,
  groupNameEn: 27,
  groupNameAr: 28,
  maxSelection: 29,
  minSelection: 30,
  freeSelection: 31,
  groupStatus: 32,
  groupSortOrder: 33,
  groupDesignType: 34,
  optionId: 35,
  optionNameEn: 36,
  optionNameAr: 37,
  optionPrice: 38,
  optionSortOrder: 39,
} as const;

export interface RafeeqNativeCategory {
  id: number;
  ar: string;
  /** audited live status (Hand Care is 0 in the store — preserved, not changed). */
  status: number;
  /** each live category carries one "ALL" subcategory (two categories have none). */
  sub: { id: number; en: string; ar: string; status: number } | null;
}

/**
 * The live Rafeeq category registry, audited from the workbook (id + Arabic
 * name + status + the category's "ALL" subcategory). Unknown canonical
 * categories emit blank category cells + a MISSING_CATEGORY warning — a Rafeeq
 * category id is never invented.
 */
export const RAFEEQ_NATIVE_CATEGORIES: Record<string, RafeeqNativeCategory> = {
  "Masks": { id: 3708630, ar: "الأقنعة", status: 1, sub: { id: 260165, en: "ALL", ar: "الكل", status: 1 } },
  "Face Care": { id: 3708631, ar: "العناية بالوجه", status: 1, sub: { id: 260166, en: "ALL", ar: "الكل", status: 1 } },
  "Hair Care": { id: 3708632, ar: "العناية بالشعر", status: 1, sub: { id: 260167, en: "ALL", ar: "الكل", status: 1 } },
  "Lashes & Nails": { id: 3708633, ar: "الرموش و الأظافر", status: 1, sub: { id: 260168, en: "ALL", ar: "الكل", status: 1 } },
  "Sun Protection": { id: 3708634, ar: "الوقاية من الشمس", status: 1, sub: { id: 260169, en: "ALL", ar: "الكل", status: 1 } },
  "Toys": { id: 3708635, ar: "الألعاب", status: 1, sub: { id: 260170, en: "ALL", ar: "الكل", status: 1 } },
  "Beauty Accessories": { id: 3708636, ar: "إكسسوارات الجمال", status: 1, sub: { id: 260171, en: "ALL", ar: "الكل", status: 1 } },
  "Beauty Bundle": { id: 3708638, ar: "بـاقـة الجـمـال", status: 1, sub: { id: 260173, en: "ALL", ar: "الكل", status: 1 } },
  "Body Care": { id: 3708639, ar: "العناية بالجسم", status: 1, sub: { id: 260174, en: "ALL", ar: "الكل", status: 1 } },
  "Dental Care": { id: 3708640, ar: "العناية بالأسنان", status: 1, sub: { id: 260175, en: "ALL", ar: "الكل", status: 1 } },
  "Electronics": { id: 3708641, ar: "إلكترونيات", status: 1, sub: { id: 260176, en: "ALL", ar: "الكل", status: 1 } },
  "Hand Care": { id: 3708642, ar: "العناية باليدين", status: 0, sub: { id: 260177, en: "ALL", ar: "الكل", status: 1 } },
  "Makeup": { id: 3708643, ar: "المكياج", status: 1, sub: { id: 260178, en: "ALL", ar: "الكل", status: 1 } },
  "Rhode Products Section": { id: 3708644, ar: "قسم منتجات رود - rhode", status: 1, sub: { id: 260179, en: "ALL", ar: "الكل", status: 1 } },
  "Summer Essentials": { id: 3708645, ar: "مستلزمات الصيف", status: 1, sub: { id: 260180, en: "ALL", ar: "الكل", status: 1 } },
  "Thailand Products": { id: 4401447, ar: "منتجات تايلاندية", status: 1, sub: null },
  "Women's Essentials": { id: 4415761, ar: "مستلزمات نسائية أساسية", status: 1, sub: null },
};

/**
 * OWNER-APPROVED explicit aliases: canonical catalog category names that map
 * to a DIFFERENTLY-NAMED existing live Rafeeq category. Exact-key lookup only
 * — never fuzzy. Rafeeq-export-specific: the canonical catalog name itself is
 * never renamed by this table.
 */
export const RAFEEQ_CATEGORY_ALIASES: Record<string, string> = {
  // pool/swim/beach merchandise → live "Summer Essentials" (id 3708645, sub ALL 260180)
  "Summer And Camping Supplies": "Summer Essentials",
};

/**
 * Resolve a canonical category name to its audited registry KEY — the exact
 * live Rafeeq category name that export cells must carry. Deterministic
 * normalization ONLY: trim + the typographic apostrophe (U+2019) folded to
 * ASCII (canonical data stores "Women’s Essentials"; the audited workbook
 * spells it "Women's Essentials" — the same live category, id 4415761), then
 * an exact registry hit or an exact owner-approved alias hit. No fuzzy
 * matching — any other difference is an unknown category.
 */
export function rafeeqCategoryKeyByName(name: string | null | undefined): string | undefined {
  const key = String(name ?? "").trim().replace(/’/g, "'");
  if (key === "") return undefined;
  if (RAFEEQ_NATIVE_CATEGORIES[key]) return key;
  const alias = RAFEEQ_CATEGORY_ALIASES[key];
  return alias !== undefined && RAFEEQ_NATIVE_CATEGORIES[alias] ? alias : undefined;
}

/** Registry lookup by canonical category name (exact key or exact alias). */
export function rafeeqCategoryByName(name: string | null | undefined): RafeeqNativeCategory | undefined {
  const key = rafeeqCategoryKeyByName(name);
  return key === undefined ? undefined : RAFEEQ_NATIVE_CATEGORIES[key];
}

/**
 * Audited product-level constants (workbook distributions): product_status = 1
 * and active = 1 on every row; product_availability = 1 for purchasable rows;
 * pos_id always blank; product_preparation_time overwhelmingly 15.
 */
export const RAFEEQ_PRODUCT_DEFAULTS = {
  productStatus: 1,
  productAvailability: 1,
  active: 1,
  preparationTime: 15,
} as const;

/**
 * Audited group-level constants for a required choose-one option group:
 * min_selection = 1 everywhere; max_selection = 1 (a single "pick 3" bundle is
 * the only exception); group_status = 1 everywhere; group_sort_order = 1 (one
 * group per product); group_design_type = 1 where populated. free_selection is
 * genuinely mixed in the store (90×1 / 81×0) — the owner-specified default 1 is
 * used and disclosed.
 */
export const RAFEEQ_GROUP_DEFAULTS = {
  maxSelection: 1,
  minSelection: 1,
  freeSelection: 1,
  groupStatus: 1,
  groupSortOrder: 1,
  groupDesignType: 1,
} as const;

/**
 * Default option-group names when canonical data exposes no reliable option
 * axis (our variant model carries no axis column — group names are NEVER
 * guessed from free product text). "Options"/"الخيارات" is also the most-used
 * group name in the live store (80 rows).
 */
export const RAFEEQ_DEFAULT_GROUP_NAME_EN = "Options";
export const RAFEEQ_DEFAULT_GROUP_NAME_AR = "الخيارات";

/**
 * OWNER-APPROVED differing-price encoding (observed live in the workbook on
 * the Smeg product): when a product's options carry DIFFERING effective
 * prices, product_price is this literal text sentinel and option_price holds
 * each option's FULL effective canonical price — never a delta.
 */
export const RAFEEQ_PRICE_ON_SELECTION = "PRICE ON SELECTION";

/** Column widths (chars) for a tidy native sheet (serializer hint only). */
export const RAFEEQ_NATIVE_COL_WIDTHS = [
  10, 22, 22, 8, 10, 14, 14, 8, 10, 14, 14, 8,
  12, 34, 34, 46, 46, 8, 8, 8, 12, 14, 8, 8, 24,
  7, 12, 16, 16, 8, 8, 8, 8, 8, 8, 12, 22, 22, 10, 10,
];
