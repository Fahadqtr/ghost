// Pure Talabat flattened-variant export builder. NO Supabase, NO network, NO
// filesystem — data in → rows / mapping candidates / warnings / blocked out.
//
// Talabat does not support product options, so every Malika variant ships as a
// standalone Talabat product. Malika's Master Catalogue stays the source of
// truth: this module never mutates products/variants and never invents a SKU or
// barcode. It is self-contained (no sibling imports) so node:test can import it
// directly. The durable mapping key is the variant SKU — never product_variants.id,
// never array order, never an index.

export type MappingStatus = "active" | "needs_review" | "archived";

export interface ExportProductInput {
  id: string;
  sku: string | null;
  barcode: string | null;
  name_en: string | null;
  name_ar: string | null;
  price: number | string | null;
  discount_price: number | string | null;
  main_category: string | null;
  description_en: string | null;
  description_ar: string | null;
  image_filename: string | null;
  image_url: string | null;
  /** Parent-level channel price override (channel_products.channel_price). */
  channel_price?: number | string | null;
  /** Approved for the Talabat channel (default true). */
  approved?: boolean;
  /** Confirmed archived/deactivated (default false). */
  archived?: boolean;
}

export interface ExportVariantInput {
  parent_product_id: string;
  sku: string | null;
  barcode: string | null;
  variant_name: string | null;      // Arabic / primary option name
  variant_name_en: string | null;   // English option name
  price: number | string | null;
  stock_quantity?: number | string | null;
}

export type TalabatWarningKind =
  | "no_variant_image"
  | "out_of_stock"
  | "excluded_not_approved"
  | "excluded_archived";

export type TalabatBlockedReason =
  | "missing_sku"
  | "missing_barcode"
  | "missing_image"
  | "duplicate_sku"
  | "duplicate_barcode";

export interface TalabatExportRow {
  sku: string;
  barcode: string;
  priceQar: string;
  discount: string;
  nameEn: string;
  nameAr: string;
  category: string;
  descEn: string;
  descAr: string;
  imageFilename: string;
}

export interface MappingSnapshot {
  nameEn: string;
  nameAr: string;
  price: string;
  barcode: string | null;
  imageFilename: string;
  availability: "InStock" | "OutOfStock";
}

export interface TalabatMappingCandidate {
  masterProductId: string;
  masterVariantSku: string | null;   // null = no-variant product
  exportedSku: string;
  exportedBarcode: string | null;
  mappingStatus: MappingStatus;
  exportSnapshot: MappingSnapshot;
}

export interface TalabatExportWarning {
  kind: TalabatWarningKind;
  masterProductId: string;
  masterVariantSku: string | null;
  exportedSku: string | null;
  message: string;
}

export interface TalabatBlockedRow {
  reason: TalabatBlockedReason;
  masterProductId: string;
  masterVariantSku: string | null;
  exportedSku: string | null;
  nameEn: string;
  detail?: string;
}

export interface TalabatExportResult {
  rows: TalabatExportRow[];
  mappings: TalabatMappingCandidate[];
  warnings: TalabatExportWarning[];
  blocked: TalabatBlockedRow[];
}

// ---- normalization (mirrors lib/talabat/mapping.ts; inlined to keep this
// module self-contained and directly test-importable) -------------------------

const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2300}-\u{23FF}\u{25A0}-\u{25FF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}]/gu;

function clean(v: unknown): string {
  let s = v == null ? "" : String(v);
  s = s.replace(EMOJI_RE, "").replace(/\(\s*\)/g, "").replace(/[ \t]{2,}/g, " ");
  return s.split("\n").map((l) => l.trim()).join("\n").trim();
}

/** Trim to the exported SKU; "" means missing (blocks the row). Never generated. */
export function normalizeExportedSku(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

/** Clean a barcode (whitespace only), never fabricated; null when empty. */
export function normalizeBarcode(value: string | null | undefined): string | null {
  const v = String(value ?? "").replace(/\s+/g, "").trim();
  return v === "" ? null : v;
}

/** Keep just the filename (strip folder/URL prefix). */
function fileNameOf(v: string | null | undefined): string {
  const s = String(v ?? "").trim();
  const i = s.lastIndexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
}

function resolveImage(p: ExportProductInput): string {
  return fileNameOf(p.image_filename) || fileNameOf(p.image_url);
}

const positive = (x: unknown): number | null => {
  const n = Number(x);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const priceStr = (n: number): string => (Number.isInteger(n) ? String(n) : String(n));

/**
 * Build a standalone listing name. If the parent name already contains the
 * option text, return the parent unchanged (never repeat the option); otherwise
 * append " — {option}".
 */
export function buildFlattenedName(parentName: unknown, optionName: unknown): string {
  const p = clean(parentName);
  const o = clean(optionName);
  if (!o) return p;
  if (p.toLowerCase().includes(o.toLowerCase())) return p;
  return `${p} — ${o}`;
}

/** No-variant effective price: channel override → valid discount → base price. */
function priceForProduct(p: ExportProductInput): number {
  return positive(p.channel_price) ?? positive(p.discount_price) ?? positive(p.price) ?? 0;
}

/** Variant effective price: own price → parent override → parent discount → parent price. */
function priceForVariant(p: ExportProductInput, v: ExportVariantInput): number {
  return positive(v.price) ?? positive(p.channel_price) ?? positive(p.discount_price) ?? positive(p.price) ?? 0;
}

interface Staged {
  row: TalabatExportRow;
  mapping: TalabatMappingCandidate;
}

/**
 * Build the Talabat export from master products + their variants.
 * - Archived / not-approved products are excluded (recorded as warnings).
 * - No-variant product → one standalone row.
 * - Product with variants → one standalone row per variant.
 * - Missing SKU / missing barcode / no valid image → blocked (never exported,
 *   no mapping). Parent barcodes are NEVER inherited by variants.
 * - Duplicate exported SKU or barcode within the export → all conflicting rows
 *   are blocked.
 */
export function buildTalabatExport(
  products: ExportProductInput[],
  variants: ExportVariantInput[],
): TalabatExportResult {
  const variantsByParent = new Map<string, ExportVariantInput[]>();
  for (const v of variants) {
    const arr = variantsByParent.get(v.parent_product_id) ?? [];
    arr.push(v);
    variantsByParent.set(v.parent_product_id, arr);
  }

  const staged: Staged[] = [];
  const warnings: TalabatExportWarning[] = [];
  const blocked: TalabatBlockedRow[] = [];

  const block = (reason: TalabatBlockedReason, pid: string, vsku: string | null, esku: string | null, nameEn: string, detail?: string) =>
    blocked.push({ reason, masterProductId: pid, masterVariantSku: vsku, exportedSku: esku || null, nameEn, detail });

  for (const p of products) {
    const nameEnParent = clean(p.name_en);
    if (p.archived === true) {
      warnings.push({ kind: "excluded_archived", masterProductId: p.id, masterVariantSku: null, exportedSku: null, message: "product archived — excluded from export" });
      continue;
    }
    if (p.approved === false) {
      warnings.push({ kind: "excluded_not_approved", masterProductId: p.id, masterVariantSku: null, exportedSku: null, message: "product not approved for Talabat — excluded" });
      continue;
    }

    const image = resolveImage(p);
    const category = clean(p.main_category);
    const descEn = clean(p.description_en);
    const descAr = clean(p.description_ar);
    const vs = variantsByParent.get(p.id) ?? [];

    if (vs.length === 0) {
      // No-variant product → one standalone row.
      const sku = normalizeExportedSku(p.sku);
      const barcode = normalizeBarcode(p.barcode);
      if (sku === "") { block("missing_sku", p.id, null, null, nameEnParent); continue; }
      if (barcode === null) { block("missing_barcode", p.id, null, sku, nameEnParent); continue; }
      if (image === "") { block("missing_image", p.id, null, sku, nameEnParent); continue; }

      const price = priceForProduct(p);
      staged.push({
        row: { sku, barcode, priceQar: priceStr(price), discount: "", nameEn: nameEnParent, nameAr: clean(p.name_ar), category, descEn, descAr, imageFilename: image },
        mapping: {
          masterProductId: p.id, masterVariantSku: null, exportedSku: sku, exportedBarcode: barcode,
          mappingStatus: "active",
          exportSnapshot: { nameEn: nameEnParent, nameAr: clean(p.name_ar), price: priceStr(price), barcode, imageFilename: image, availability: "InStock" },
        },
      });
      continue;
    }

    // Product with variants → one standalone row per valid variant.
    for (const v of vs) {
      const sku = normalizeExportedSku(v.sku);
      const barcode = normalizeBarcode(v.barcode);            // never the parent's
      const nameEn = buildFlattenedName(p.name_en, v.variant_name_en ?? v.variant_name);
      const nameAr = buildFlattenedName(p.name_ar, v.variant_name);

      if (sku === "") { block("missing_sku", p.id, null, null, nameEn); continue; }
      if (barcode === null) { block("missing_barcode", p.id, sku, sku, nameEn); continue; }
      if (image === "") { block("missing_image", p.id, sku, sku, nameEn); continue; }

      // Variants have no own image column → they inherit the parent's image, so
      // every variant row is flagged for review until it gets a real image.
      warnings.push({ kind: "no_variant_image", masterProductId: p.id, masterVariantSku: sku, exportedSku: sku, message: "variant inherits the parent image (no per-variant image)" });

      const stockNum = v.stock_quantity == null ? null : Number(v.stock_quantity);
      const outOfStock = stockNum != null && Number.isFinite(stockNum) && stockNum <= 0;
      if (outOfStock) {
        warnings.push({ kind: "out_of_stock", masterProductId: p.id, masterVariantSku: sku, exportedSku: sku, message: "variant is out of stock (still listed; availability reflects OutOfStock)" });
      }

      const price = priceForVariant(p, v);
      staged.push({
        row: { sku, barcode, priceQar: priceStr(price), discount: "", nameEn, nameAr, category, descEn, descAr, imageFilename: image },
        mapping: {
          masterProductId: p.id, masterVariantSku: sku, exportedSku: sku, exportedBarcode: barcode,
          mappingStatus: "needs_review", // inherits parent image → review before it is "clean"
          exportSnapshot: { nameEn, nameAr, price: priceStr(price), barcode, imageFilename: image, availability: outOfStock ? "OutOfStock" : "InStock" },
        },
      });
    }
  }

  // Duplicate detection within the export (SKU first, then barcode over survivors).
  const survivors = dedupe(staged, "sku", "duplicate_sku", block);
  const finalValid = dedupe(survivors, "barcode", "duplicate_barcode", block);

  return {
    rows: finalValid.map((s) => s.row),
    mappings: finalValid.map((s) => s.mapping),
    warnings,
    blocked,
  };
}

function dedupe(
  staged: Staged[],
  field: "sku" | "barcode",
  reason: TalabatBlockedReason,
  block: (reason: TalabatBlockedReason, pid: string, vsku: string | null, esku: string | null, nameEn: string, detail?: string) => void,
): Staged[] {
  const counts = new Map<string, number>();
  for (const s of staged) counts.set(s.row[field], (counts.get(s.row[field]) ?? 0) + 1);
  const survivors: Staged[] = [];
  for (const s of staged) {
    if ((counts.get(s.row[field]) ?? 0) > 1) {
      block(reason, s.mapping.masterProductId, s.mapping.masterVariantSku, s.row.sku, s.row.nameEn, `${field}=${s.row[field]}`);
    } else {
      survivors.push(s);
    }
  }
  return survivors;
}

// ---- CSV (10-column Talabat format) -----------------------------------------

export const TALABAT_HEADERS = [
  "SKU", "Barcode", "Price (QAR)", "Discount",
  "Product Name EN", "Product Name AR", "Category",
  "Description EN", "Description AR", "New Image Filename",
] as const;

const csvCell = (v: string): string => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** Serialize valid rows to the 10-column CSV (CRLF; caller prepends any BOM). */
export function talabatResultToCsv(rows: TalabatExportRow[]): string {
  const line = (cells: readonly string[]) => cells.map(csvCell).join(",");
  const out = [line(TALABAT_HEADERS)];
  for (const r of rows) {
    out.push(line([r.sku, r.barcode, r.priceQar, r.discount, r.nameEn, r.nameAr, r.category, r.descEn, r.descAr, r.imageFilename]));
  }
  return out.join("\r\n") + "\r\n";
}

// ---- Preview / dry-run summary ----------------------------------------------

export interface TalabatExportSummary {
  baseProducts: number;
  variants: number;
  validRows: number;
  blockedRows: number;
  missingSku: number;
  missingBarcode: number;
  missingImage: number;
  duplicateSku: number;
  duplicateBarcode: number;
  noVariantImage: number;
}

export function summarizeTalabatExport(
  result: TalabatExportResult,
  totals: { baseProducts: number; variants: number },
): TalabatExportSummary {
  const byReason = (r: TalabatBlockedReason) => result.blocked.filter((b) => b.reason === r).length;
  return {
    baseProducts: totals.baseProducts,
    variants: totals.variants,
    validRows: result.rows.length,
    blockedRows: result.blocked.length,
    missingSku: byReason("missing_sku"),
    missingBarcode: byReason("missing_barcode"),
    missingImage: byReason("missing_image"),
    duplicateSku: byReason("duplicate_sku"),
    duplicateBarcode: byReason("duplicate_barcode"),
    noVariantImage: result.warnings.filter((w) => w.kind === "no_variant_image").length,
  };
}

// ---- Mapping persistence PLAN (pure; the I/O wrapper lives in
// lib/talabat/persist-mappings.ts) --------------------------------------------

export interface ExistingMappingRow {
  id: string;
  channel_product_id: string | null;
}

export type MappingWritePlan =
  | { op: "insert"; row: Record<string, unknown> }
  | { op: "update"; id: string; patch: Record<string, unknown> };

/**
 * Decide how to persist one mapping candidate. An UPDATE never includes
 * channel_product_id, so a value Talabat already assigned is preserved. An
 * INSERT sets channel_product_id to null (unknown until Talabat returns it).
 */
export function planMappingWrite(
  channelId: string,
  candidate: TalabatMappingCandidate,
  existing: ExistingMappingRow | null,
  nowIso: string,
): MappingWritePlan {
  const common = {
    exported_sku: candidate.exportedSku,
    exported_barcode: candidate.exportedBarcode,
    mapping_status: candidate.mappingStatus,
    export_snapshot: candidate.exportSnapshot,
    last_exported_at: nowIso,
    updated_at: nowIso,
  };
  if (existing) {
    return { op: "update", id: existing.id, patch: { ...common } }; // channel_product_id preserved
  }
  return {
    op: "insert",
    row: {
      channel_id: channelId,
      master_product_id: candidate.masterProductId,
      master_variant_sku: candidate.masterVariantSku,
      channel_product_id: null,
      created_at: nowIso,
      ...common,
    },
  };
}
