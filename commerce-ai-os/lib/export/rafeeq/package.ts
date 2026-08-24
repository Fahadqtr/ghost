// INT.2D — Rafeeq outbound package PLAN (PURE).
//
// Transforms the certified Rafeeq preview rows (buildRafeeqPreview) into the plan
// for the downloadable package: the XLSX rows (AoA), the SKU-named image entries,
// referential integrity, filename-collision detection, and the manifest. It
// REUSES the existing Rafeeq contract (RAFEEQ_HEADERS + RAFEEQ_CATEGORIES) — no
// second template — and the INT.2A image-naming + shared package-core helpers.
// The Rafeeq Product ID column is sourced from ECL (blank sentinel "new product"
// for unmapped) — the legacy per-store id column is never read here. No I/O.

import { RAFEEQ_HEADERS, RAFEEQ_CATEGORIES } from "../../exporters.ts";
import { primaryImageName, additionalImageName, normalizeExtension } from "../image-naming.ts";
import {
  sanitizeSpreadsheetText,
  extensionFromUrl,
  checkReferentialIntegrity,
  PACKAGE_LIMITS,
  type AoaCell,
  type PackagedFile,
} from "../package-core.ts";
import type { RafeeqPreviewRow } from "./preview.ts";
import type { ExportReasonCode } from "../validation.ts";

/** The canonical Rafeeq columns (REUSED — the single Rafeeq template). */
export const RAFEEQ_PACKAGE_COLUMNS = RAFEEQ_HEADERS;

/** Column indexes stored as spreadsheet TEXT. */
export const RAFEEQ_TEXT_COLUMNS = [
  7, // IMAGE NAME (packaged filename)
  8, // BARCODE
  9, // RAFEEQ ID
] as const;
export const RAFEEQ_PRICE_COLUMN = 4;

/** The literal Rafeeq new-product marker (the existing template convention). */
export const RAFEEQ_NEW_MARKER = "new product";

export { PACKAGE_LIMITS };

/**
 * Rafeeq export modes. UPDATES is intentionally NOT here: there is no durable
 * per-listing export snapshot for Rafeeq, so a changed-listing diff cannot be
 * proven — offering it would be inventing diffs (§7). It is surfaced as
 * UNSUPPORTED, never as a silent all/mapped resend.
 */
export type RafeeqGenerationMode = "all" | "new" | "selected";
export const RAFEEQ_UPDATES_SUPPORTED = false;

/** Row key of a sellable row (product id for simple rows; product::variant for
 *  variant rows) — the selection + identity key across the flattened dataset. */
export function previewRowKey(r: Pick<RafeeqPreviewRow, "rowKey">): string {
  return r.rowKey;
}
export function isExportableRow(r: Pick<RafeeqPreviewRow, "status">): boolean {
  return r.status === "READY" || r.status === "WARNING";
}

export interface GenerationSelection {
  mode: RafeeqGenerationMode;
  selectedKeys?: readonly string[];
}
export interface GenerationSet {
  included: RafeeqPreviewRow[];
  excludedBlocked: RafeeqPreviewRow[];
  excludedByMode: RafeeqPreviewRow[];
  counts: { total: number; ready: number; warnings: number; blocked: number; includedRows: number };
}

/**
 * Resolve which product rows enter the package. BLOCKED rows (incl. needs_review
 * conflicts) are ALWAYS excluded.
 *   • all      — every exportable row
 *   • new      — exportable rows with NO active Rafeeq identity (unmapped)
 *   • selected — exportable rows whose key is in selectedKeys
 */
export function resolveRafeeqGenerationSet(rows: readonly RafeeqPreviewRow[], selection: GenerationSelection): GenerationSet {
  const wanted = selection.mode === "selected" ? new Set(selection.selectedKeys ?? []) : null;
  const included: RafeeqPreviewRow[] = [];
  const excludedBlocked: RafeeqPreviewRow[] = [];
  const excludedByMode: RafeeqPreviewRow[] = [];
  let ready = 0, warnings = 0, blocked = 0;

  for (const r of rows) {
    if (r.status === "READY") ready++;
    else if (r.status === "WARNING") warnings++;
    else if (r.status === "BLOCKED") blocked++;

    if (!isExportableRow(r)) { if (r.status === "BLOCKED") excludedBlocked.push(r); continue; }

    const inMode =
      selection.mode === "all" ? true
      : selection.mode === "new" ? r.rafeeqId === null
      : /* selected */ !!wanted && wanted.has(previewRowKey(r));

    if (inMode) included.push(r);
    else excludedByMode.push(r);
  }
  return { included, excludedBlocked, excludedByMode, counts: { total: rows.length, ready, warnings, blocked, includedRows: included.length } };
}

// ── image plan (SKU-named) ────────────────────────────────────────────────────
export interface PlannedImage { filename: string; sourceUrl: string; kind: "primary" | "gallery" }
export interface RowImagePlan { rowKey: string; sku: string; primary: PlannedImage | null; gallery: PlannedImage[] }

export function planRowImages(r: RafeeqPreviewRow): RowImagePlan {
  const rowKey = previewRowKey(r);
  const sku = r.sku;
  const primaryUrl = typeof r.primaryImageUrl === "string" ? r.primaryImageUrl.trim() : "";
  const ext = extensionFromUrl(primaryUrl || null);
  const primary: PlannedImage | null = sku && primaryUrl ? { filename: primaryImageName(sku, ext), sourceUrl: primaryUrl, kind: "primary" } : null;
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

export function primaryFilenameFor(sku: string, ext: string): string {
  return primaryImageName(sku, normalizeExtension(ext));
}

/**
 * Deterministic post-sanitization filename collision detection (§15). Returns the
 * set of primary filenames shared by more than one row — the generator BLOCKS
 * package generation if any exist, so the archive never ships colliding files.
 */
export function detectFilenameCollisions(primaryFilenames: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const f of primaryFilenames) counts.set(f.toLowerCase(), (counts.get(f.toLowerCase()) ?? 0) + 1);
  return [...counts.entries()].filter(([, n]) => n > 1).map(([f]) => f).sort();
}

// ── XLSX rows (AoA) — reuse the Rafeeq column contract exactly ─────────────────
export interface RafeeqPackageRow {
  categoryEn: string;
  categoryAr: string;
  nameEn: string;
  nameAr: string;
  price: number | null;
  descriptionEn: string;
  descriptionAr: string;
  imageName: string;   // packaged primary filename (SKU-based) — the IMAGE NAME column
  /** BARCODE column = canonical PARENT product SKU (owner template rule) —
   *  never the real EAN, never a variant sku/barcode. Option rows repeat it. */
  barcode: string;
  rafeeqId: string;    // ECL external_product_id, or the "new product" marker
}

/** Project one exportable preview row → its outbound package row. */
export function toPackageRow(r: RafeeqPreviewRow, imageFilename: string): RafeeqPackageRow {
  const cat = r.category ? RAFEEQ_CATEGORIES[r.category] : undefined;
  return {
    categoryEn: r.category ?? "",
    categoryAr: cat?.ar ?? "",
    nameEn: r.title,
    nameAr: r.titleAr,
    price: r.price,
    descriptionEn: r.descriptionEn,
    descriptionAr: r.descriptionAr,
    imageName: imageFilename,           // consistent with the packaged file (§10)
    barcode: r.barcode ?? "",
    rafeeqId: r.rafeeqId ?? RAFEEQ_NEW_MARKER, // never fabricated — literal marker for new
  };
}

const num = (v: number | null): AoaCell => (typeof v === "number" && Number.isFinite(v) ? v : "");

export function buildRafeeqXlsxAoa(rows: readonly RafeeqPackageRow[]): AoaCell[][] {
  const out: AoaCell[][] = [RAFEEQ_PACKAGE_COLUMNS.slice()];
  for (const r of rows) {
    out.push([
      sanitizeSpreadsheetText(r.categoryEn),     // 0 CATEGORY - ENGLISH
      sanitizeSpreadsheetText(r.categoryAr),     // 1 CATEGORY - ARABIC
      sanitizeSpreadsheetText(r.nameEn),         // 2 PRODUCT NAME - ENGLISH
      sanitizeSpreadsheetText(r.nameAr),         // 3 PRODUCT NAME - ARABIC
      num(r.price),                              // 4 PRICE (NUMBER)
      sanitizeSpreadsheetText(r.descriptionEn),  // 5 DESCRIPTION - ENGLISH
      sanitizeSpreadsheetText(r.descriptionAr),  // 6 DESCRIPTION - ARABIC
      r.imageName,                               // 7 IMAGE NAME (TEXT)
      r.barcode,                                 // 8 BARCODE (TEXT)
      r.rafeeqId,                                // 9 RAFEEQ ID (TEXT)
    ]);
  }
  return out;
}

export { checkReferentialIntegrity, type PackagedFile };

// ── pre-generation plan ───────────────────────────────────────────────────────
export interface GenerationPlanPreview {
  products: number;
  ready: number;
  warnings: number;
  blocked: number;
  mapped: number;
  unmapped: number;
  needsReview: number;
  rowsIncluded: number;
  imagesExpected: number;
  blockersByReason: Partial<Record<ExportReasonCode, number>>;
}

export function previewGenerationPlan(rows: readonly RafeeqPreviewRow[], selection: GenerationSelection): GenerationPlanPreview {
  const set = resolveRafeeqGenerationSet(rows, selection);
  let mapped = 0, unmapped = 0, needsReview = 0, imagesExpected = 0;
  for (const r of rows) {
    if (r.rafeeqId !== null) mapped++; else unmapped++;
    if (r.needsOwnerReview) needsReview++;
  }
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
  return { products: rows.length, ready: set.counts.ready, warnings: set.counts.warnings, blocked: set.counts.blocked, mapped, unmapped, needsReview, rowsIncluded: set.counts.includedRows, imagesExpected, blockersByReason };
}

// ── manifest ──────────────────────────────────────────────────────────────────
export interface RafeeqManifestInput {
  storefrontKey: string;
  mode: RafeeqGenerationMode;
  generatedAt: string;
  actor: string | null;
  productRowCount: number;
  mappedCount: number;
  unmappedCount: number;
  needsReviewExcluded: number;
  imageCount: number;
  warningCount: number;
  excludedBlockedCount: number;
  outputFilename: string;
  previewReference: Record<string, unknown>;
}

export function buildManifest(input: RafeeqManifestInput): Record<string, unknown> {
  return {
    schema: "rafeeq-export-manifest/1",
    destination: input.storefrontKey,
    mode: input.mode,
    generated_at: input.generatedAt,
    actor: input.actor,
    product_row_count: input.productRowCount,
    mapped_count: input.mappedCount,
    unmapped_count: input.unmappedCount,
    needs_review_excluded: input.needsReviewExcluded,
    image_count: input.imageCount,
    warning_count: input.warningCount,
    excluded_blocked_count: input.excludedBlockedCount,
    output_filename: input.outputFilename,
    preview_reference: input.previewReference,
  };
}
