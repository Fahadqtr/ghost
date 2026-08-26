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
  | "availability";

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
};

const FIELD_ALIASES: Record<SnoonuSyncField, string[]> = {
  spi: ["spi", "spiuniqueidentifier"],
  name_en: ["productnameenupdate", "productnameen"],
  name_ar: ["productnamearupdate", "productnamear"],
  description_en: ["productdescriptionenupdate", "productdescriptionen"],
  description_ar: ["productdescriptionarupdate", "productdescriptionar"],
  sku: ["skuupdate", "sku"],
  barcode: ["barcodeupdate", "barcode"],
  price: ["priceglobalupdate", "priceglobal"],
  availability: [],
};

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
  /** True/False from the store availability column; null = unreadable/absent. */
  availability: boolean | null;
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
    const availability = parseAvailabilityCell(availabilityRaw);
    if (availability === null && clean(availabilityRaw) !== null) warnings.push("قيمة توفر غير مقروءة");
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
}

export interface SnoonuProblemRow {
  rowNum: number | null;
  spi: string | null;
  productSku: string | null;
  message: string;
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
  newProducts: number;
  newMissingSku: number;
  newMissingBarcode: number;
  newMissingBoth: number;
  removedFromSnoonu: number;
  conflicts: number;
  blocked: number;
}

export interface SnoonuSyncPlan {
  counts: SnoonuSyncCounts;
  matched: SnoonuMatchedPlan[];
  unchanged: SnoonuMatchedPlan[];
  news: SnoonuNewPlan[];
  removals: SnoonuRemovalPlan[];
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
  rows: readonly SnoonuSyncRow[];
  emptySpiRows: readonly number[];
  canonical: readonly SnoonuCanonicalRecord[];
  listings: readonly SnoonuListingRecord[];
}): SnoonuSyncPlan {
  const canonicalById = new Map(input.canonical.map((c) => [c.id, c]));

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
    const product = productIds.length === 1 ? canonicalById.get(productIds[0]) : undefined;
    if (productIds.length === 1 && !product) {
      conflicts.push({ rowNum: r.rowNum, spi: r.spi, productSku: null, message: "ربط SPI يشير إلى منتج غير موجود" });
      continue;
    }

    if (!product) {
      // NEW Snoonu product — blank SKU/barcode MUST NOT block creation.
      const missingSku = safeIdentifier(r.sku) === null;
      const missingBarcode = safeIdentifier(r.barcode) === null;
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
        sku: safeIdentifier(r.sku),
        barcode: safeIdentifier(r.barcode),
        price: r.price,
        availability: r.availability,
        blocked: !r.nameEn && !r.nameAr ? "لا اسم إنجليزي أو عربي — لا يمكن الإنشاء" : null,
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
      changes.push({ field: "price", from: product.price === null ? null : String(product.price), to: String(r.price) });
    }
    if (r.availability !== null) {
      const to = availabilityToStockStatus(r.availability);
      if (to !== (product.stockStatus ?? null)) changes.push({ field: "availability", from: product.stockStatus, to });
    }
    // blank/whitespace NEVER erases a real canonical identifier
    const skuTo = safeIdentifier(r.sku);
    if (skuTo && skuTo !== product.sku && !isPendingSku(skuTo)) {
      changes.push({ field: "sku", from: isPendingSku(product.sku) ? null : product.sku, to: skuTo });
    }
    const barcodeTo = safeIdentifier(r.barcode);
    if (barcodeTo && barcodeTo !== (product.barcode ?? null)) {
      changes.push({ field: "barcode", from: product.barcode, to: barcodeTo });
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
  // workbook. ONLY active + SPI-shaped mappings participate; a product with
  // any non-SPI-shaped active listing is surfaced as a conflict instead.
  const workbookSpis = new Set(input.rows.map((r) => r.spi.toLowerCase()));
  const removals: SnoonuRemovalPlan[] = [];
  const byProduct = new Map<string, SnoonuListingRecord[]>();
  for (const l of active) byProduct.set(l.productId, [...(byProduct.get(l.productId) ?? []), l]);
  for (const [productId, ls] of byProduct) {
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
    counts,
    matched: matched.map((m) => [m.spi, m.productId, m.changes]),
    news: news.map((n) => [n.spi, n.klass, n.sku, n.barcode, n.price, n.availability]),
    removals: removals.map((x) => [x.spi, x.productId]),
    duplicateSpis,
  }));
  const fingerprint = hash.digest("hex");

  return {
    counts,
    matched,
    unchanged,
    news,
    removals,
    conflicts,
    blockedRows,
    duplicateSpis,
    applyBlocked: duplicateSpis.length > 0,
    fingerprint,
  };
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
