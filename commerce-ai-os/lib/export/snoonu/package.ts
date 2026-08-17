// INT.2C — Snoonu outbound package PLAN (PURE).
//
// Transforms the certified Snoonu preview rows (buildSnoonuPreview) into the plan
// for the downloadable package: the XLSX rows (AoA), the SKU-named image entries,
// the referential-integrity check, and the manifest. It REUSES the existing
// Snoonu column contract (SNOONU_HEADERS) — never a second, divergent template —
// and the INT.2A image-naming + shared package-core helpers. It performs NO I/O.
// Framework-free so node:test loads it directly.

import { SNOONU_HEADERS } from "../../exporters.ts";
import { primaryImageName, additionalImageName, normalizeExtension } from "../image-naming.ts";
import {
  sanitizeSpreadsheetText,
  extensionFromUrl,
  checkReferentialIntegrity,
  PACKAGE_LIMITS,
  type AoaCell,
  type PackagedFile,
} from "../package-core.ts";
import type { SnoonuPreviewRow } from "./preview.ts";
import type { ExportReasonCode } from "../validation.ts";

/** The canonical Snoonu masterlist columns (REUSED — the single Snoonu template). */
export const SNOONU_PACKAGE_COLUMNS = SNOONU_HEADERS;

/** Column indexes stored as spreadsheet TEXT (never numeric → no scientific notation). */
export const SNOONU_TEXT_COLUMNS = [
  0, // Snoonu ID (SPI — may be long numeric)
  1, // SKU
  2, // Barcode
] as const;
/** Numeric column indexes. */
export const SNOONU_PRICE_COLUMN = 7;
export const SNOONU_DISCOUNT_COLUMN = 8;

export { PACKAGE_LIMITS };

/** Generation modes (§ export modes). Change detection is NOT invented — see below. */
export type SnoonuGenerationMode = "all" | "new" | "updates" | "selected";

/** Stable key for a Snoonu row (product grain → one row per product). */
export function previewRowKey(r: Pick<SnoonuPreviewRow, "internalProductId">): string {
  return r.internalProductId;
}

/** Exportable = NOT blocked (READY or WARNING). Never BLOCKED. */
export function isExportableRow(r: Pick<SnoonuPreviewRow, "status">): boolean {
  return r.status === "READY" || r.status === "WARNING";
}

export interface GenerationSelection {
  mode: SnoonuGenerationMode;
  selectedKeys?: readonly string[];
}

export interface GenerationSet {
  included: SnoonuPreviewRow[];
  excludedBlocked: SnoonuPreviewRow[];
  /** dropped only because they fell outside the chosen mode/selection. */
  excludedByMode: SnoonuPreviewRow[];
  counts: { total: number; ready: number; warnings: number; blocked: number; includedRows: number };
}

/**
 * Resolve which product rows enter the package. BLOCKED rows are ALWAYS excluded.
 *   • all      — every exportable row
 *   • new      — exportable rows with NO storefront SPI (unmapped / not yet listed)
 *   • updates  — exportable rows that ARE mapped (have a storefront SPI). This is
 *                the "resend already-listed products" set. It is NOT a field-level
 *                change diff — the current evidence cannot prove what changed, so
 *                no change detection is invented (§).
 *   • selected — exportable rows whose key is in selectedKeys
 */
export function resolveSnoonuGenerationSet(
  rows: readonly SnoonuPreviewRow[],
  selection: GenerationSelection,
): GenerationSet {
  const wanted = selection.mode === "selected" ? new Set(selection.selectedKeys ?? []) : null;
  const included: SnoonuPreviewRow[] = [];
  const excludedBlocked: SnoonuPreviewRow[] = [];
  const excludedByMode: SnoonuPreviewRow[] = [];
  let ready = 0, warnings = 0, blocked = 0;

  for (const r of rows) {
    if (r.status === "READY") ready++;
    else if (r.status === "WARNING") warnings++;
    else if (r.status === "BLOCKED") blocked++;

    if (!isExportableRow(r)) { if (r.status === "BLOCKED") excludedBlocked.push(r); continue; }

    const inMode =
      selection.mode === "all" ? true
      : selection.mode === "new" ? r.spi === null
      : selection.mode === "updates" ? r.spi !== null
      : /* selected */ !!wanted && wanted.has(previewRowKey(r));

    if (inMode) included.push(r);
    else excludedByMode.push(r);
  }

  return { included, excludedBlocked, excludedByMode, counts: { total: rows.length, ready, warnings, blocked, includedRows: included.length } };
}

// ── image plan (SKU-named; never title-based) ─────────────────────────────────

export interface PlannedImage { filename: string; sourceUrl: string; kind: "primary" | "gallery" }
export interface RowImagePlan { rowKey: string; sku: string; primary: PlannedImage | null; gallery: PlannedImage[] }

/** Deterministic SKU-based image plan for one product row. */
export function planRowImages(r: SnoonuPreviewRow): RowImagePlan {
  const rowKey = previewRowKey(r);
  const sku = r.sku;
  const primaryUrl = typeof r.primaryImageUrl === "string" ? r.primaryImageUrl.trim() : "";
  const ext = extensionFromUrl(primaryUrl || null);
  const primary: PlannedImage | null =
    sku && primaryUrl ? { filename: primaryImageName(sku, ext), sourceUrl: primaryUrl, kind: "primary" } : null;

  const gallery: PlannedImage[] = [];
  if (sku && Array.isArray(r.galleryImageUrls)) {
    let position = 2;
    for (const raw of r.galleryImageUrls) {
      if (gallery.length >= PACKAGE_LIMITS.maxGalleryPerRow) break;
      const url = typeof raw === "string" ? raw.trim() : "";
      if (!url) continue;
      gallery.push({ filename: additionalImageName(sku, position, extensionFromUrl(url)), sourceUrl: url, kind: "gallery" });
      position++;
    }
  }
  return { rowKey, sku, primary, gallery };
}

/** Recompute a row's primary filename with a (possibly MIME-corrected) extension. */
export function primaryFilenameFor(sku: string, ext: string): string {
  return primaryImageName(sku, normalizeExtension(ext));
}

// ── XLSX rows (AoA) — reuse the Snoonu column contract exactly ─────────────────

export interface SnoonuPackageRow {
  snoonuId: string;   // ECL SPI (storefront-scoped); "" for a new/unmapped product
  sku: string;
  barcode: string;
  nameEn: string;
  nameAr: string;
  category: string;
  subCategory: string;
  price: number | null;
  discountPrice: number | null;
  stock: string;      // left blank — no inventory read (§ no inventory)
  snoonuStatus: string;
  imageUrl: string;   // source URL (existing contract's Image URL column)
  descriptionEn: string;
  descriptionAr: string;
  keywordsEn: string;
  keywordsAr: string;
  /** the FINAL packaged primary filename (SKU-based) — for the ZIP + integrity, not a column. */
  imageFilename: string;
}

/** Project one exportable preview row → its outbound package row. */
export function toPackageRow(r: SnoonuPreviewRow, imageFilename: string): SnoonuPackageRow {
  return {
    snoonuId: r.spi ?? "",              // never invented — blank means "new product"
    sku: r.sku,
    barcode: r.barcode ?? "",
    nameEn: r.title,
    nameAr: r.titleAr,
    category: r.category ?? "",
    subCategory: r.subCategory ?? "",
    price: r.price,
    discountPrice: r.discountPrice,
    stock: "",
    snoonuStatus: r.snoonuStatus,
    imageUrl: r.primaryImageUrl ?? "",
    descriptionEn: r.descriptionEn,
    descriptionAr: r.descriptionAr,
    keywordsEn: r.keywordsEn,
    keywordsAr: r.keywordsAr,
    imageFilename,
  };
}

const num = (v: number | null): AoaCell => (typeof v === "number" && Number.isFinite(v) ? v : "");

/** Build the Snoonu sheet as an array-of-arrays (header + one row per product). */
export function buildSnoonuXlsxAoa(rows: readonly SnoonuPackageRow[]): AoaCell[][] {
  const out: AoaCell[][] = [SNOONU_PACKAGE_COLUMNS.slice()];
  for (const r of rows) {
    out.push([
      r.snoonuId,                              // 0  Snoonu ID (TEXT)
      r.sku,                                   // 1  SKU (TEXT)
      r.barcode,                               // 2  Barcode (TEXT)
      sanitizeSpreadsheetText(r.nameEn),       // 3  Name EN
      sanitizeSpreadsheetText(r.nameAr),       // 4  Name AR
      sanitizeSpreadsheetText(r.category),     // 5  Category
      sanitizeSpreadsheetText(r.subCategory),  // 6  Sub Category
      num(r.price),                            // 7  Price (NUMBER)
      num(r.discountPrice),                    // 8  Discount Price (NUMBER)
      r.stock,                                 // 9  Stock (blank)
      sanitizeSpreadsheetText(r.snoonuStatus), // 10 Snoonu Status
      sanitizeSpreadsheetText(r.imageUrl),     // 11 Image URL
      sanitizeSpreadsheetText(r.descriptionEn),// 12 Description EN
      sanitizeSpreadsheetText(r.descriptionAr),// 13 Description AR
      sanitizeSpreadsheetText(r.keywordsEn),   // 14 Keywords EN
      sanitizeSpreadsheetText(r.keywordsAr),   // 15 Keywords AR
    ]);
  }
  return out;
}

export { checkReferentialIntegrity, type PackagedFile };

// ── pre-generation plan (§ show exact preview + blocked reasons) ───────────────

export interface GenerationPlanPreview {
  products: number;
  ready: number;
  warnings: number;
  blocked: number;
  mapped: number;
  unmapped: number;
  rowsIncluded: number;
  imagesExpected: number;
  blockersByReason: Partial<Record<ExportReasonCode, number>>;
}

export function previewGenerationPlan(rows: readonly SnoonuPreviewRow[], selection: GenerationSelection): GenerationPlanPreview {
  const set = resolveSnoonuGenerationSet(rows, selection);
  let mapped = 0, unmapped = 0, imagesExpected = 0;
  for (const r of rows) { if (r.spi !== null) mapped++; else unmapped++; }
  for (const r of set.included) {
    const plan = planRowImages(r);
    if (plan.primary) imagesExpected += 1;
    imagesExpected += plan.gallery.length;
  }
  const blockersByReason: Partial<Record<ExportReasonCode, number>> = {};
  for (const r of set.excludedBlocked) {
    for (const reason of r.reasons) {
      if (!reason.blocking) continue;
      blockersByReason[reason.code] = (blockersByReason[reason.code] ?? 0) + 1;
    }
  }
  return {
    products: rows.length,
    ready: set.counts.ready,
    warnings: set.counts.warnings,
    blocked: set.counts.blocked,
    mapped,
    unmapped,
    rowsIncluded: set.counts.includedRows,
    imagesExpected,
    blockersByReason,
  };
}

// ── manifest ──────────────────────────────────────────────────────────────────

export interface SnoonuManifestInput {
  storefrontKey: string;
  mode: SnoonuGenerationMode;
  generatedAt: string;
  actor: string | null;
  productRowCount: number;
  mappedCount: number;
  unmappedCount: number;
  imageCount: number;
  warningCount: number;
  excludedBlockedCount: number;
  outputFilename: string;
  previewReference: Record<string, unknown>;
}

export function buildManifest(input: SnoonuManifestInput): Record<string, unknown> {
  return {
    schema: "snoonu-export-manifest/1",
    destination: input.storefrontKey,
    mode: input.mode,
    generated_at: input.generatedAt,
    actor: input.actor,
    product_row_count: input.productRowCount,
    mapped_count: input.mappedCount,
    unmapped_count: input.unmappedCount,
    image_count: input.imageCount,
    warning_count: input.warningCount,
    excluded_blocked_count: input.excludedBlockedCount,
    output_filename: input.outputFilename,
    preview_reference: input.previewReference,
  };
}
