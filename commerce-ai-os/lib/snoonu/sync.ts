// SNOONU CATALOG SYNC — pure plan engine (owner redesign of the Snoonu
// "تحديث الكتالوج من Excel" workflow).
//
// OWNER RULES baked in:
//   • the Snoonu update workbook is the CURRENT Snoonu catalog state;
//   • SPI(UniqueIdentifier) is the PRIMARY identity — matched against the
//     snoonu:malikas external-channel listings; name matching is never used
//     and SKU/barcode are NOT required (new Snoonu products may have both
//     blank);
//   • ambiguous SPI mappings FAIL CLOSED; a duplicate SPI inside the workbook
//     BLOCKS the whole apply;
//   • Availability for … Ali Bin Abdullah Street(Update) maps to the canonical
//     availability field (التوفر في سنونو / حالة التوفر): True → "In Stock",
//     False → "Out of Stock" — NEVER an archive/delete;
//   • matched rows update ONLY the owner-approved fields; a blank Excel
//     SKU/barcode NEVER erases a real canonical value;
//   • a workbook row with no canonical match is a NEW product; blank
//     SKU/barcode do not block creation — the canonical row stores an
//     explicit PENDING sentinel SKU (products.sku is NOT NULL) that is never
//     exported back to Snoonu and never treated as a real identity; the
//     product is classified NEW — WAITING FOR SKU/BARCODE until the owner's
//     second workbook (same SPI matching) supplies the identifiers;
//   • a canonical product whose ACTIVE snoonu:malikas SPI listing is absent
//     from the workbook was deleted from Snoonu → REMOVED FROM SNOONU
//     (lifecycle stop + listing archive — never a destructive DELETE); this
//     never touches unmapped products, other channels, needs_review or
//     non-SPI-shaped mappings;
//   • everything is planned here PURELY — preview is write-free by
//     construction, and apply happens only after the owner's explicit
//     confirmation in the UI.

import { createHash } from "node:crypto";
import { normalizeHeader } from "../products/excel-import/core.ts";

// ── identity ─────────────────────────────────────────────────────────────────

export const SNOONU_STOREFRONT_KEY = "snoonu:malikas";
/** Snoonu SPI shape (24 hex chars) — placeholders/foreign ids never match. */
export const SPI_RE = /^[0-9a-f]{24}$/i;
export const spiLike = (v: string): boolean => SPI_RE.test(v.trim());

/** explicit not-a-real-SKU sentinel for NEW Snoonu products with blank SKU. */
export const SNOONU_PENDING_SKU_PREFIX = "PENDING-SNOONU-";
export const pendingSkuForSpi = (spi: string): string => `${SNOONU_PENDING_SKU_PREFIX}${spi.trim().toLowerCase()}`;
export const isPendingSku = (sku: string | null | undefined): boolean =>
  typeof sku === "string" && sku.startsWith(SNOONU_PENDING_SKU_PREFIX);

// ── columns ──────────────────────────────────────────────────────────────────

export type SnoonuSyncField =
  | "spi"
  | "name_en"
  | "name_ar"
  | "description_en"
  | "description_ar"
  | "sku"
  | "barcode"
  | "price"
  | "availability"
  | "stock";

/** Arabic labels for the mapping UI — availability is RECOGNIZED, never غير مستخدم. */
export const SNOONU_SYNC_FIELD_LABEL: Record<SnoonuSyncField, string> = {
  spi: "SPI (هوية سنونو الأساسية)",
  name_en: "الاسم (إنجليزي)",
  name_ar: "الاسم (عربي)",
  description_en: "الوصف (إنجليزي)",
  description_ar: "الوصف (عربي)",
  sku: "SKU",
  barcode: "الباركود",
  price: "السعر",
  availability: "التوفر في سنونو / حالة التوفر",
  stock: "مخزون سنونو (الفرع) — 0 أو unavailable = غير متوفر",
};

/** Owner-facing explanation of Snoonu's bulk stock encoding. */
export const SNOONU_STOCK_RULE_NOTE = "سنونو: 0 أو unavailable = غير متوفر · أي كمية أكبر من 0 = متوفر";

const FIELD_ALIASES: Record<SnoonuSyncField, string[]> = {
  spi: ["spi", "spiuniqueidentifier"],
  name_en: ["productnameenupdate", "productnameen"],
  name_ar: ["productnamearupdate", "productnamear"],
  description_en: ["productdescriptionenupdate", "productdescriptionen"],
  description_ar: ["productdescriptionarupdate", "productdescriptionar"],
  sku: ["skuupdate", "sku"],
  barcode: ["barcodeupdate", "barcode"],
  // "Price (QAR)" is the REAL header of the Snoonu bulk-update (barcode-fill)
  // workbook — both spellings normalize into the same proposed-price field.
  price: ["priceglobalupdate", "priceglobal", "priceqar"],
  availability: [],
  stock: [],
};

/**
 * The store whose stock/availability column drives canonical availability.
 * Both real workbooks name it: the catalog export as
 * "Availability for Malikas Universe Beauty Ali Bin Abdullah Street(Update)"
 * and the bulk-update export as "Stock Ali Bin Abdullah Street". Matching is
 * by normalized token, so neither full header string is hardcoded.
 */
export const SNOONU_STORE_TOKEN = "alibinabdullah";

export interface SnoonuSyncColumn {
  index: number;
  header: string;
  field: SnoonuSyncField | null;
  status: "auto" | "ignored";
}

/** Detect the Snoonu update-workbook columns. The store-scoped availability
 *  header maps by PREFIX (the store address is embedded in the header). */
export function detectSnoonuSyncColumns(headers: readonly unknown[]): SnoonuSyncColumn[] {
  const seen = new Set<SnoonuSyncField>();
  return headers.map((h, index) => {
    const header = typeof h === "string" ? h : String(h ?? "");
    const norm = normalizeHeader(header);
    let field: SnoonuSyncField | null = null;
    if (norm.startsWith("availabilityfor")) field = "availability";
    // the BULK workbook has no boolean availability column — the store's stock
    // column carries the state (0 / "unavailable" ⇒ out, quantity ⇒ in).
    else if (norm.startsWith("stock") && norm.includes(SNOONU_STORE_TOKEN)) field = "stock";
    else {
      for (const f of Object.keys(FIELD_ALIASES) as SnoonuSyncField[]) {
        if (FIELD_ALIASES[f].includes(norm)) { field = f; break; }
      }
    }
    if (field && seen.has(field)) field = null; // first column wins; twins ignored
    if (field) seen.add(field);
    return { index, header, field, status: field ? ("auto" as const) : ("ignored" as const) };
  });
}

// ── rows ─────────────────────────────────────────────────────────────────────

export interface SnoonuSyncRow {
  rowNum: number;
  spi: string;
  nameEn: string | null;
  nameAr: string | null;
  descriptionEn: string | null;
  descriptionAr: string | null;
  sku: string | null;
  barcode: string | null;
  price: number | null;
  /** effective availability for the store: the boolean column when present,
   *  otherwise DERIVED from the store's stock column. null = not stated. */
  availability: boolean | null;
  /** the store stock column's own reading (bulk workbook), null when absent. */
  stockState: "IN" | "OUT" | null;
  /** which column decided `availability` — for honest preview reporting. */
  availabilitySource: "availability_column" | "stock_column" | null;
  warnings: string[];
}

const clean = (v: unknown): string | null => {
  const s = typeof v === "string" ? v : v === null || v === undefined ? "" : String(v);
  const t = s.trim();
  return t === "" ? null : t;
};

export function parseAvailabilityCell(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  const t = (clean(v) ?? "").toLowerCase();
  if (["true", "1", "yes", "متوفر"].includes(t)) return true;
  if (["false", "0", "no", "غير متوفر"].includes(t)) return false;
  return null;
}

/**
 * Snoonu bulk stock encoding (owner rule, from the real bulk workbook):
 *   numeric 0            → OUT OF STOCK
 *   literal "unavailable"→ OUT OF STOCK
 *   any positive quantity→ IN STOCK
 * Anything else (blank/unreadable) is null — never guessed.
 */
export function parseStockCell(v: unknown): "IN" | "OUT" | null {
  if (typeof v === "number" && Number.isFinite(v)) return v > 0 ? "IN" : "OUT";
  const t = (clean(v) ?? "").toLowerCase();
  if (t === "") return null;
  if (t === "unavailable" || t === "out of stock" || t === "غير متوفر") return "OUT";
  const n = Number.parseFloat(t.replace(/,/g, ""));
  if (Number.isFinite(n)) return n > 0 ? "IN" : "OUT";
  return null;
}

export function parsePriceCell(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
  const t = clean(v);
  if (!t) return null;
  const n = Number.parseFloat(t.replace(/,/g, ""));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Normalize extracted sheet data (header excluded) into SnoonuSyncRows. */
export function parseSnoonuSyncData(
  dataRows: readonly (readonly unknown[])[],
  rowNums: readonly number[],
  columns: readonly SnoonuSyncColumn[],
): { rows: SnoonuSyncRow[]; emptySpiRows: number[] } {
  const col = new Map<SnoonuSyncField, number>();
  for (const c of columns) if (c.field) col.set(c.field, c.index);
  const rows: SnoonuSyncRow[] = [];
  const emptySpiRows: number[] = [];
  for (let i = 0; i < dataRows.length; i++) {
    const raw = dataRows[i] ?? [];
    if (raw.every((c) => clean(c) === null)) continue; // fully blank line
    const rowNum = rowNums[i] ?? i + 2;
    const cell = (f: SnoonuSyncField): unknown => (col.has(f) ? raw[col.get(f)!] : undefined);
    const spi = clean(cell("spi"));
    if (!spi) { emptySpiRows.push(rowNum); continue; }
    const warnings: string[] = [];
    const availabilityRaw = cell("availability");
    const fromAvailability = parseAvailabilityCell(availabilityRaw);
    if (fromAvailability === null && clean(availabilityRaw) !== null) warnings.push("قيمة توفر غير مقروءة");
    const stockRaw = cell("stock");
    const stockState = parseStockCell(stockRaw);
    if (stockState === null && clean(stockRaw) !== null) warnings.push("قيمة مخزون غير مقروءة");
    // the boolean column wins when present; otherwise the store's stock column
    // decides (0 / "unavailable" ⇒ out, positive quantity ⇒ in).
    const availability = fromAvailability !== null ? fromAvailability : stockState === null ? null : stockState === "IN";
    const availabilitySource: SnoonuSyncRow["availabilitySource"] =
      fromAvailability !== null ? "availability_column" : stockState !== null ? "stock_column" : null;
    const priceRaw = cell("price");
    const price = parsePriceCell(priceRaw);
    if (price === null && clean(priceRaw) !== null) warnings.push("سعر غير مقروء");
    rows.push({
      rowNum,
      spi,
      nameEn: clean(cell("name_en")),
      nameAr: clean(cell("name_ar")),
      descriptionEn: clean(cell("description_en")),
      descriptionAr: clean(cell("description_ar")),
      sku: clean(cell("sku")),
      barcode: clean(cell("barcode")),
      price,
      availability,
      stockState,
      availabilitySource,
      warnings,
    });
  }
  return { rows, emptySpiRows };
}

/** AoA convenience (header row first) — tests and small callers. */
export function parseSnoonuSyncRows(
  aoa: readonly (readonly unknown[])[],
  columns: readonly SnoonuSyncColumn[],
): { rows: SnoonuSyncRow[]; emptySpiRows: number[] } {
  const dataRows = aoa.slice(1);
  return parseSnoonuSyncData(dataRows, dataRows.map((_, i) => i + 2), columns);
}

// ── canonical context ────────────────────────────────────────────────────────

export interface SnoonuCanonicalRecord {
  id: string;
  sku: string;
  barcode: string | null;
  nameEn: string | null;
  nameAr: string | null;
  descriptionEn: string | null;
  descriptionAr: string | null;
  price: number | null;
  /** "In Stock" | "Out of Stock" | null */
  stockStatus: string | null;
  lifecycleState: string;
}

export interface SnoonuListingRecord {
  productId: string;
  /** external_product_id (the SPI or a legacy placeholder). */
  externalId: string;
  /** active | needs_review | archived */
  mappingStatus: string;
  /** true when the listing row targets a variant grain (excluded here). */
  variantGrain: boolean;
}

// ── import mode ──────────────────────────────────────────────────────────────

/**
 * FULL    — «مزامنة سنونو الكاملة»: the workbook is the COMPLETE Snoonu
 *           catalog; absence of a mapped SPI may classify REMOVED FROM SNOONU.
 * PARTIAL — «تحديث جزئي — بدون حذف»: only rows physically present update;
 *           absent products are COMPLETELY ignored — the planner is
 *           structurally incapable of producing a removal in this mode.
 */
export type SnoonuImportMode = "FULL" | "PARTIAL";

export const SNOONU_MODE_LABEL: Record<SnoonuImportMode, string> = {
  FULL: "مزامنة سنونو الكاملة",
  PARTIAL: "تحديث جزئي — بدون حذف",
};

export const SNOONU_MODE_NOTICE: Record<SnoonuImportMode, string> = {
  FULL: "هذا ملف مزامنة كامل. المنتجات المرتبطة بسنونو وغير الموجودة في الملف قد يتم تصنيفها كمحذوفة من سنونو.",
  PARTIAL: "هذا ملف تحديث جزئي. المنتجات غير الموجودة في الملف لن يتم حذفها أو إيقافها.",
};

/**
 * Schema-based recommendation ONLY — the human always chooses explicitly and
 * a partial workbook is NEVER silently promoted to FULL removal semantics.
 * The complete Snoonu export carries the store availability column and the
 * (Update)-suffixed description columns; the bulk-update file carries neither.
 */
export function recommendSnoonuImportMode(columns: readonly SnoonuSyncColumn[]): SnoonuImportMode {
  const has = (f: SnoonuSyncField) => columns.some((c) => c.field === f);
  return has("availability") && has("description_en") ? "FULL" : "PARTIAL";
}

// ── plan ─────────────────────────────────────────────────────────────────────

export type SnoonuUpdateField =
  | "name_en" | "name_ar" | "description_en" | "description_ar"
  | "price" | "availability" | "sku" | "barcode";

export interface SnoonuFieldChange {
  field: SnoonuUpdateField;
  from: string | null;
  to: string;
}

export interface SnoonuMatchedPlan {
  rowNum: number;
  spi: string;
  productId: string;
  productSku: string;
  displayName: string;
  changes: SnoonuFieldChange[];
  warnings: string[];
}

export type SnoonuNewClass =
  | "NEW"
  | "NEW_WAITING_SKU"
  | "NEW_WAITING_BARCODE"
  | "NEW_WAITING_SKU_BARCODE";

export interface SnoonuNewPlan {
  rowNum: number;
  spi: string;
  klass: SnoonuNewClass;
  nameEn: string | null;
  nameAr: string | null;
  descriptionEn: string | null;
  descriptionAr: string | null;
  sku: string | null;
  barcode: string | null;
  price: number | null;
  availability: boolean | null;
  /** creation blocked (e.g. no name at all) — listed, never silently dropped. */
  blocked: string | null;
}

export interface SnoonuRemovalPlan {
  productId: string;
  spi: string;
  productSku: string;
  displayName: string;
  /** canonical lifecycle NOW — decides the valid removal behavior:
   *  ACTIVE → certified ACTIVE→STOPPED transition + archive listing;
   *  DRAFT  → archive the Snoonu listing ONLY (DRAFT→STOPPED is not a legal
   *           transition and the business meaning is "stop the listing");
   *  STOPPED→ archive listing only (no lifecycle mutation needed). */
  lifecycleState: string;
  plannedBehavior: "stop_and_archive" | "archive_listing_only";
}

export interface SnoonuProblemRow {
  rowNum: number | null;
  spi: string | null;
  productSku: string | null;
  message: string;
}

/**
 * PRICE_REVIEW_ZERO — «مراجعة السعر — السعر صفر»: a positive canonical price
 * with an imported price of 0 NEVER updates automatically; the row is flagged
 * for an explicit per-row owner resolution (keep current / accept zero).
 * Unrelated safe fields on the same row still preview and apply normally.
 */
export interface SnoonuZeroPriceReview {
  rowNum: number;
  spi: string;
  productId: string;
  productSku: string;
  displayName: string;
  currentPrice: number;
  proposedPrice: 0;
}

/**
 * IDENTITY_COLLISION — «تعارض هوية المنتج»: an imported non-blank SKU/barcode
 * already owned by a DIFFERENT canonical product. Detected in the plan —
 * BEFORE any DB unique-constraint failure. The colliding identifier update
 * (or creation) is withheld; nothing merges, reassigns or deletes — a
 * separate owner-controlled duplicate-resolution workflow handles it.
 */
export interface SnoonuIdentityCollision {
  rowNum: number;
  spi: string;
  identifier: "sku" | "barcode";
  source: { productId: string | null; sku: string | null; barcode: string | null } | null;
  proposed: { sku: string | null; barcode: string | null };
  colliding: { productId: string; sku: string; barcode: string | null; name: string };
}

/**
 * RECONCILE_EXISTING — «ربط منتج موجود»: a row unmatched by SPI whose imported
 * SKU AND barcode both resolve EXACTLY to the SAME canonical product (which
 * has no active snoonu:malikas mapping yet). Never fuzzy: exact normalized
 * equality of BOTH identifiers, fail-closed on ambiguity, on split ownership
 * (SKU→A, barcode→B) and on an already-mapped target. Apply links ONLY the
 * SPI (no product creation, no rename, no merge) and the row's safe field
 * updates then flow through the normal diff path against the same product.
 */
export interface SnoonuReconcilePlan {
  rowNum: number;
  spi: string;
  importedSku: string;
  importedBarcode: string;
  productId: string;
  canonicalSku: string;
  canonicalBarcode: string | null;
  displayName: string;
  /** the product's current snoonu:malikas mapping shown to the owner —
   *  null (none) or the legacy placeholder external id being upgraded. */
  currentSnoonuMapping: string | null;
  /** active LEGACY placeholder external ids (non-SPI-shaped) that apply
   *  archives when the real SPI listing is written (identity upgrade —
   *  never a delete, and only ever on this product's own listings). */
  placeholderMappings: string[];
  /** safe owner-approved field updates from the same row (normal diff path). */
  changes: SnoonuFieldChange[];
  warnings: string[];
}

export interface SnoonuSyncCounts {
  totalExcelRows: number;
  matchedExisting: number;
  unchanged: number;
  availabilityTrueToFalse: number;
  availabilityFalseToTrue: number;
  priceChanges: number;
  contentChanges: number;
  skuChanges: number;
  barcodeChanges: number;
  zeroPriceReviews: number;
  identityCollisions: number;
  reconcileExisting: number;
  /** rows the FILE says are out of stock (0 / "unavailable" / False). */
  outOfStockInFile: number;
  /** rows the FILE says are in stock (positive quantity / True). */
  inStockInFile: number;
  newProducts: number;
  newMissingSku: number;
  newMissingBarcode: number;
  newMissingBoth: number;
  removedFromSnoonu: number;
  conflicts: number;
  blocked: number;
}

export interface SnoonuSyncPlan {
  mode: SnoonuImportMode;
  counts: SnoonuSyncCounts;
  matched: SnoonuMatchedPlan[];
  unchanged: SnoonuMatchedPlan[];
  news: SnoonuNewPlan[];
  removals: SnoonuRemovalPlan[];
  reconciles: SnoonuReconcilePlan[];
  zeroPriceReviews: SnoonuZeroPriceReview[];
  identityCollisions: SnoonuIdentityCollision[];
  conflicts: SnoonuProblemRow[];
  blockedRows: SnoonuProblemRow[];
  /** duplicate SPI inside the workbook — the WHOLE apply is blocked. */
  duplicateSpis: string[];
  applyBlocked: boolean;
  /** stable fingerprint of the decisive plan — apply must present the same. */
  fingerprint: string;
}

const AVAILABLE = "In Stock";
const UNAVAILABLE = "Out of Stock";
export const availabilityToStockStatus = (available: boolean): string => (available ? AVAILABLE : UNAVAILABLE);

/** owner rule: a non-empty, non-sentinel, single-token value may update ids. */
const safeIdentifier = (v: string | null): string | null => {
  if (!v) return null;
  const t = v.trim();
  if (t === "" || /\s/.test(t) || isPendingSku(t)) return null;
  return t;
};

export function planSnoonuSync(input: {
  mode: SnoonuImportMode;
  rows: readonly SnoonuSyncRow[];
  emptySpiRows: readonly number[];
  canonical: readonly SnoonuCanonicalRecord[];
  listings: readonly SnoonuListingRecord[];
}): SnoonuSyncPlan {
  const canonicalById = new Map(input.canonical.map((c) => [c.id, c]));
  // identity ownership across the WHOLE canonical catalog — collisions are
  // detected here, in the plan, before any DB unique-constraint could fire.
  const skuOwner = new Map<string, SnoonuCanonicalRecord>();
  const barcodeOwner = new Map<string, SnoonuCanonicalRecord>();
  for (const c of input.canonical) {
    if (c.sku) skuOwner.set(c.sku.toLowerCase(), c);
    if (c.barcode) barcodeOwner.set(c.barcode, c);
  }
  const zeroPriceReviews: SnoonuZeroPriceReview[] = [];
  const identityCollisions: SnoonuIdentityCollision[] = [];

  // ACTIVE, product-grain listings only; needs_review/archived and variant
  // grains never participate (fail closed on removal + matching).
  const active = input.listings.filter((l) => l.mappingStatus === "active" && !l.variantGrain);
  const bySpi = new Map<string, SnoonuListingRecord[]>();
  for (const l of active) {
    const key = l.externalId.trim().toLowerCase();
    bySpi.set(key, [...(bySpi.get(key) ?? []), l]);
  }

  const conflicts: SnoonuProblemRow[] = [];
  const blockedRows: SnoonuProblemRow[] = input.emptySpiRows.map((rowNum) => ({
    rowNum, spi: null, productSku: null, message: "صف بدون SPI — لا هوية سنونو",
  }));

  // duplicate SPI inside the workbook → the whole apply is blocked (rule 10).
  const seenSpi = new Map<string, number>();
  const duplicateSpis: string[] = [];
  for (const r of input.rows) {
    const key = r.spi.toLowerCase();
    seenSpi.set(key, (seenSpi.get(key) ?? 0) + 1);
  }
  for (const [spi, n] of seenSpi) if (n > 1) duplicateSpis.push(spi);

  const matched: SnoonuMatchedPlan[] = [];
  const unchanged: SnoonuMatchedPlan[] = [];
  const news: SnoonuNewPlan[] = [];
  const reconciles: SnoonuReconcilePlan[] = [];

  // active snoonu:malikas listings per product — a reconcile target must have
  // NONE (an already-mapped product never reconciles to a second SPI).
  const activeByProduct = new Map<string, SnoonuListingRecord[]>();
  for (const l of active) activeByProduct.set(l.productId, [...(activeByProduct.get(l.productId) ?? []), l]);

  for (const r of input.rows) {
    const key = r.spi.toLowerCase();
    if ((seenSpi.get(key) ?? 0) > 1) {
      blockedRows.push({ rowNum: r.rowNum, spi: r.spi, productSku: null, message: "SPI مكرر داخل الملف — التطبيق محظور" });
      continue;
    }
    const listings = bySpi.get(key) ?? [];
    const productIds = [...new Set(listings.map((l) => l.productId))];
    if (productIds.length > 1) {
      // ambiguous SPI mapping — FAIL CLOSED
      conflicts.push({ rowNum: r.rowNum, spi: r.spi, productSku: null, message: "SPI مربوط بأكثر من منتج — يحتاج مراجعة" });
      continue;
    }
    let product = productIds.length === 1 ? canonicalById.get(productIds[0]) : undefined;
    if (productIds.length === 1 && !product) {
      conflicts.push({ rowNum: r.rowNum, spi: r.spi, productSku: null, message: "ربط SPI يشير إلى منتج غير موجود" });
      continue;
    }

    // RECONCILE_EXISTING — attempted BEFORE the NEW/collision branch, and only
    // by EXACT identity: BOTH identifiers present, BOTH owned by the SAME
    // canonical product, target not already actively snoonu-mapped. Anything
    // less fails closed below (split ownership → collision; single identifier
    // → the ordinary NEW/collision rules; already-mapped target → conflict).
    let reconcile: { importedSku: string; importedBarcode: string; placeholders: string[] } | null = null;
    if (!product) {
      const impSku = safeIdentifier(r.sku);
      const impBarcode = safeIdentifier(r.barcode);
      if (impSku && impBarcode && !isPendingSku(impSku)) {
        const skuOwned = skuOwner.get(impSku.toLowerCase());
        const barcodeOwned = barcodeOwner.get(impBarcode);
        if (skuOwned && barcodeOwned && skuOwned.id !== barcodeOwned.id) {
          // SKU→A + barcode→B — ambiguous identity, FAIL CLOSED as collision.
          identityCollisions.push({
            rowNum: r.rowNum, spi: r.spi, identifier: "sku", source: null,
            proposed: { sku: impSku, barcode: impBarcode },
            colliding: { productId: skuOwned.id, sku: skuOwned.sku, barcode: skuOwned.barcode, name: skuOwned.nameEn ?? skuOwned.nameAr ?? skuOwned.sku },
          });
          identityCollisions.push({
            rowNum: r.rowNum, spi: r.spi, identifier: "barcode", source: null,
            proposed: { sku: impSku, barcode: impBarcode },
            colliding: { productId: barcodeOwned.id, sku: barcodeOwned.sku, barcode: barcodeOwned.barcode, name: barcodeOwned.nameEn ?? barcodeOwned.nameAr ?? barcodeOwned.sku },
          });
          conflicts.push({ rowNum: r.rowNum, spi: r.spi, productSku: null, message: "هوية غامضة: SKU يشير لمنتج والباركود لمنتج آخر — يحتاج مراجعة" });
          continue;
        }
        if (skuOwned && barcodeOwned && skuOwned.id === barcodeOwned.id) {
          // an existing active SPI-SHAPED mapping blocks (another SPI already
          // owns this product); LEGACY placeholder mappings (external id not
          // SPI-shaped, e.g. the product's own SKU) do NOT block — they are
          // the very identity gap reconciliation upgrades, and apply archives
          // them alongside writing the real SPI listing.
          const existing = activeByProduct.get(skuOwned.id) ?? [];
          if (existing.some((l) => spiLike(l.externalId))) {
            conflicts.push({ rowNum: r.rowNum, spi: r.spi, productSku: skuOwned.sku, message: "المنتج مرتبط بالفعل بـ SPI سنونو نشط آخر — لا ربط تلقائي" });
            continue;
          }
          if (existing.length > 1) {
            // more than one placeholder candidate — which row to upgrade is
            // ambiguous, so FAIL CLOSED rather than guess.
            conflicts.push({ rowNum: r.rowNum, spi: r.spi, productSku: skuOwned.sku, message: "أكثر من ربط سنونو قديم للمنتج — يحتاج مراجعة يدوية" });
            continue;
          }
          reconcile = {
            importedSku: impSku,
            importedBarcode: impBarcode,
            placeholders: existing.map((l) => l.externalId),
          };
          product = skuOwned;
        }
      }
    }

    if (!product) {
      // NEW Snoonu product — blank SKU/barcode MUST NOT block creation, but a
      // supplied identifier already owned by another product is an IDENTITY
      // COLLISION and blocks THIS row's creation (never worked around).
      const newSku = safeIdentifier(r.sku);
      const newBarcode = safeIdentifier(r.barcode);
      let collision: SnoonuIdentityCollision | null = null;
      const skuOwned = newSku ? skuOwner.get(newSku.toLowerCase()) : undefined;
      const barcodeOwned = newBarcode ? barcodeOwner.get(newBarcode) : undefined;
      if (skuOwned || barcodeOwned) {
        const owner = (skuOwned ?? barcodeOwned)!;
        collision = {
          rowNum: r.rowNum,
          spi: r.spi,
          identifier: skuOwned ? "sku" : "barcode",
          source: null,
          proposed: { sku: newSku, barcode: newBarcode },
          colliding: { productId: owner.id, sku: owner.sku, barcode: owner.barcode, name: owner.nameEn ?? owner.nameAr ?? owner.sku },
        };
        identityCollisions.push(collision);
      }
      const missingSku = newSku === null;
      const missingBarcode = newBarcode === null;
      const klass: SnoonuNewClass = missingSku && missingBarcode
        ? "NEW_WAITING_SKU_BARCODE" : missingSku ? "NEW_WAITING_SKU" : missingBarcode ? "NEW_WAITING_BARCODE" : "NEW";
      news.push({
        rowNum: r.rowNum,
        spi: r.spi,
        klass,
        nameEn: r.nameEn,
        nameAr: r.nameAr,
        descriptionEn: r.descriptionEn,
        descriptionAr: r.descriptionAr,
        sku: newSku,
        barcode: newBarcode,
        price: r.price,
        availability: r.availability,
        blocked: collision
          ? "تعارض هوية المنتج — المعرّف مملوك لمنتج آخر"
          : !r.nameEn && !r.nameAr
            ? "لا اسم إنجليزي أو عربي — لا يمكن الإنشاء"
            : null,
      });
      continue;
    }

    // MATCHED — owner-approved field updates only; preview shows every diff.
    const changes: SnoonuFieldChange[] = [];
    const text = (field: SnoonuUpdateField, from: string | null, to: string | null) => {
      if (to !== null && to !== (from ?? null)) changes.push({ field, from, to });
    };
    text("name_en", product.nameEn, r.nameEn);
    text("name_ar", product.nameAr, r.nameAr);
    text("description_en", product.descriptionEn, r.descriptionEn);
    text("description_ar", product.descriptionAr, r.descriptionAr);
    if (r.price !== null && r.price !== (product.price ?? null)) {
      if (r.price === 0 && (product.price ?? 0) > 0) {
        // PRICE_REVIEW_ZERO — a zero can never silently overwrite a positive
        // price. Price fails closed for this row; other fields still apply.
        zeroPriceReviews.push({
          rowNum: r.rowNum,
          spi: r.spi,
          productId: product.id,
          productSku: product.sku,
          displayName: product.nameEn ?? product.nameAr ?? product.sku,
          currentPrice: product.price as number,
          proposedPrice: 0,
        });
      } else {
        changes.push({ field: "price", from: product.price === null ? null : String(product.price), to: String(r.price) });
      }
    }
    if (r.availability !== null) {
      const to = availabilityToStockStatus(r.availability);
      if (to !== (product.stockStatus ?? null)) changes.push({ field: "availability", from: product.stockStatus, to });
    }
    // blank/whitespace NEVER erases a real canonical identifier, and an
    // identifier already OWNED by a different product is an IDENTITY
    // COLLISION — withheld here, before any unique-constraint failure.
    const sourceRef = { productId: product.id, sku: product.sku, barcode: product.barcode };
    const skuTo = safeIdentifier(r.sku);
    if (skuTo && skuTo !== product.sku && !isPendingSku(skuTo)) {
      const owner = skuOwner.get(skuTo.toLowerCase());
      if (owner && owner.id !== product.id) {
        identityCollisions.push({
          rowNum: r.rowNum,
          spi: r.spi,
          identifier: "sku",
          source: sourceRef,
          proposed: { sku: skuTo, barcode: safeIdentifier(r.barcode) },
          colliding: { productId: owner.id, sku: owner.sku, barcode: owner.barcode, name: owner.nameEn ?? owner.nameAr ?? owner.sku },
        });
      } else {
        changes.push({ field: "sku", from: isPendingSku(product.sku) ? null : product.sku, to: skuTo });
      }
    }
    const barcodeTo = safeIdentifier(r.barcode);
    if (barcodeTo && barcodeTo !== (product.barcode ?? null)) {
      const owner = barcodeOwner.get(barcodeTo);
      if (owner && owner.id !== product.id) {
        identityCollisions.push({
          rowNum: r.rowNum,
          spi: r.spi,
          identifier: "barcode",
          source: sourceRef,
          proposed: { sku: skuTo, barcode: barcodeTo },
          colliding: { productId: owner.id, sku: owner.sku, barcode: owner.barcode, name: owner.nameEn ?? owner.nameAr ?? owner.sku },
        });
      } else {
        changes.push({ field: "barcode", from: product.barcode, to: barcodeTo });
      }
    }

    if (reconcile) {
      // reconciled rows carry their safe field diffs but are NOT counted as
      // matched — apply links the SPI first, then applies these changes.
      reconciles.push({
        rowNum: r.rowNum,
        spi: r.spi,
        importedSku: reconcile.importedSku,
        importedBarcode: reconcile.importedBarcode,
        productId: product.id,
        canonicalSku: product.sku,
        canonicalBarcode: product.barcode,
        displayName: product.nameEn ?? product.nameAr ?? product.sku,
        currentSnoonuMapping: reconcile.placeholders[0] ?? null,
        placeholderMappings: reconcile.placeholders,
        changes,
        warnings: r.warnings,
      });
      continue;
    }
    const item: SnoonuMatchedPlan = {
      rowNum: r.rowNum,
      spi: r.spi,
      productId: product.id,
      productSku: product.sku,
      displayName: product.nameEn ?? product.nameAr ?? product.sku,
      changes,
      warnings: r.warnings,
    };
    (changes.length === 0 ? unchanged : matched).push(item);
  }

  // REMOVED FROM SNOONU — a mapped product whose SPI is absent from the
  // workbook. HARD INVARIANT: absence can classify a removal ONLY in FULL
  // mode — in PARTIAL mode this loop never runs, so the removal candidate
  // count is STRUCTURALLY zero (absent products are completely ignored).
  // ONLY active + SPI-shaped mappings participate; a product with any
  // non-SPI-shaped active listing is surfaced as a conflict instead.
  const workbookSpis = new Set(input.rows.map((r) => r.spi.toLowerCase()));
  const removals: SnoonuRemovalPlan[] = [];
  const byProduct = new Map<string, SnoonuListingRecord[]>();
  for (const l of active) byProduct.set(l.productId, [...(byProduct.get(l.productId) ?? []), l]);
  for (const [productId, ls] of input.mode === "FULL" ? byProduct : new Map<string, SnoonuListingRecord[]>()) {
    const product = canonicalById.get(productId);
    if (!product) continue;
    const spiListings = ls.filter((l) => spiLike(l.externalId));
    const nonSpi = ls.filter((l) => !spiLike(l.externalId));
    if (spiListings.length === 0) continue; // never mapped by real SPI → untouched
    const anyPresent = spiListings.some((l) => workbookSpis.has(l.externalId.trim().toLowerCase()));
    if (anyPresent) continue;
    if (nonSpi.length > 0) {
      conflicts.push({ rowNum: null, spi: spiListings[0].externalId, productSku: product.sku, message: "ربط سنونو مختلط (SPI + معرّف قديم) — لا إزالة تلقائية" });
      continue;
    }
    if (product.lifecycleState === "STOPPED") continue; // already out of the active catalog
    removals.push({
      productId,
      spi: spiListings[0].externalId,
      productSku: product.sku,
      displayName: product.nameEn ?? product.nameAr ?? product.sku,
      lifecycleState: product.lifecycleState,
      plannedBehavior: product.lifecycleState === "ACTIVE" ? "stop_and_archive" : "archive_listing_only",
    });
  }

  const counts: SnoonuSyncCounts = {
    totalExcelRows: input.rows.length + input.emptySpiRows.length,
    matchedExisting: matched.length + unchanged.length,
    unchanged: unchanged.length,
    availabilityTrueToFalse: matched.filter((m) => m.changes.some((c) => c.field === "availability" && c.to === UNAVAILABLE)).length,
    availabilityFalseToTrue: matched.filter((m) => m.changes.some((c) => c.field === "availability" && c.to === AVAILABLE)).length,
    priceChanges: matched.filter((m) => m.changes.some((c) => c.field === "price")).length,
    contentChanges: matched.filter((m) => m.changes.some((c) => ["name_en", "name_ar", "description_en", "description_ar"].includes(c.field))).length,
    skuChanges: matched.filter((m) => m.changes.some((c) => c.field === "sku")).length,
    barcodeChanges: matched.filter((m) => m.changes.some((c) => c.field === "barcode")).length,
    zeroPriceReviews: zeroPriceReviews.length,
    identityCollisions: identityCollisions.length,
    reconcileExisting: reconciles.length,
    outOfStockInFile: input.rows.filter((r) => r.availability === false).length,
    inStockInFile: input.rows.filter((r) => r.availability === true).length,
    newProducts: news.length,
    newMissingSku: news.filter((n) => n.klass === "NEW_WAITING_SKU" || n.klass === "NEW_WAITING_SKU_BARCODE").length,
    newMissingBarcode: news.filter((n) => n.klass === "NEW_WAITING_BARCODE" || n.klass === "NEW_WAITING_SKU_BARCODE").length,
    newMissingBoth: news.filter((n) => n.klass === "NEW_WAITING_SKU_BARCODE").length,
    removedFromSnoonu: removals.length,
    conflicts: conflicts.length,
    blocked: blockedRows.length,
  };

  // Hash is a stream — write() absorbs (no DB-verb in this pure module).
  const hash = createHash("sha256");
  hash.write(JSON.stringify({
    mode: input.mode,
    counts,
    matched: matched.map((m) => [m.spi, m.productId, m.changes]),
    news: news.map((n) => [n.spi, n.klass, n.sku, n.barcode, n.price, n.availability]),
    removals: removals.map((x) => [x.spi, x.productId]),
    reconciles: reconciles.map((x) => [x.spi, x.productId, x.changes]),
    zeroPriceReviews: zeroPriceReviews.map((z) => [z.spi, z.currentPrice]),
    identityCollisions: identityCollisions.map((i) => [i.spi, i.identifier, i.colliding.productId]),
    duplicateSpis,
  }));
  const fingerprint = hash.digest("hex");

  return {
    mode: input.mode,
    counts,
    matched,
    unchanged,
    news,
    removals,
    reconciles,
    zeroPriceReviews,
    identityCollisions,
    conflicts,
    blockedRows,
    duplicateSpis,
    applyBlocked: duplicateSpis.length > 0,
    fingerprint,
  };
}

// ── scoped REPAIR plan (pure) ────────────────────────────────────────────────

export interface SnoonuRepairPlan {
  reconciles: SnoonuReconcilePlan[];
  removals: SnoonuRemovalPlan[];
  /** nothing else from the plan is included — repair never re-runs a full apply. */
  scope: "failed_operations_only";
}

/**
 * The subset of a freshly-planned workbook that represents operations still
 * OUTSTANDING: SPI reconciliations and Snoonu removals. Rows that already
 * succeeded disappear naturally (their SPI now matches; removed products are
 * archived/stopped), so re-planning against live data yields exactly the
 * residual failures — no stored failure list, nothing fabricated.
 */
export function selectSnoonuRepairPlan(plan: SnoonuSyncPlan): SnoonuRepairPlan {
  return { reconciles: plan.reconciles, removals: plan.removals, scope: "failed_operations_only" };
}

// ── Snoonu return/update workbook (task 7) ───────────────────────────────────

/** The Snoonu update-workbook headers, preserved EXACTLY. */
export const SNOONU_RETURN_HEADERS = [
  "SPI(UniqueIdentifier)",
  "Product Name (En)(Update)",
  "Product Name (Ar)(Update)",
  "Product Description (En)(Update)",
  "Product Description (Ar)(Update)",
  "SKU(Update)",
  "Barcode(Update)",
  "Price Global(Update)",
  "Availability for Malikas Universe Beauty Ali Bin Abdullah Street(Update)",
] as const;

export interface SnoonuReturnRecord {
  spi: string;
  product: SnoonuCanonicalRecord;
}

/**
 * Rows for the Snoonu-compatible update workbook — canonical values only,
 * nothing invented: a PENDING sentinel SKU exports as BLANK, a missing
 * barcode as blank, availability from the canonical stock status.
 */
export function buildSnoonuReturnAoa(records: readonly SnoonuReturnRecord[]): (string | number)[][] {
  const rows = records.map(({ spi, product }) => [
    spi,
    product.nameEn ?? "",
    product.nameAr ?? "",
    product.descriptionEn ?? "",
    product.descriptionAr ?? "",
    isPendingSku(product.sku) ? "" : product.sku,
    product.barcode ?? "",
    product.price ?? "",
    product.stockStatus === UNAVAILABLE ? "False" : product.stockStatus === AVAILABLE ? "True" : "",
  ]);
  return [[...SNOONU_RETURN_HEADERS], ...rows];
}
