// RAFEEQ NATIVE-OPTION PACKAGE PLAN (PURE).
//
// Transforms the certified PRODUCT-grain Rafeeq preview (buildRafeeqPreview)
// into the plan for the downloadable package on the AUDITED native template
// (native-template.ts — worksheet "data", exactly 40 headers):
//   • a SIMPLE product   → ONE physical row, groups = 0, group/option cells blank;
//   • a product w/ options → ONE physical row PER option, IDENTICAL parent
//     fields on every repeated row (same name/price/barcode/image), groups = 1,
//     only the option cells varying. The repeated rows are ONE Rafeeq product.
// The BARCODE cell = canonical parent SKU (owner rule). product_id is the
// resolved ECL id, or BLANK for a new record — numeric Rafeeq ids are NEVER
// invented (the audited workbook only shows Rafeeq-generated ids). group_id /
// option_id are always blank for the same reason. Images are packaged ONCE per
// product under the parent-SKU filename; every repeated row references that one
// file — never duplicated per option. No I/O.

import {
  RAFEEQ_NATIVE_HEADERS,
  RAFEEQ_PRODUCT_DEFAULTS,
  RAFEEQ_GROUP_DEFAULTS,
  RAFEEQ_PRICE_ON_SELECTION,
  NATIVE_COL,
  rafeeqCategoryByName,
  rafeeqCategoryKeyByName,
} from "./native-template.ts";
import { primaryImageName, normalizeExtension } from "../image-naming.ts";
import {
  sanitizeSpreadsheetText,
  extensionFromUrl,
  checkReferentialIntegrity,
  PACKAGE_LIMITS,
  type AoaCell,
  type PackagedFile,
} from "../package-core.ts";
import type { RafeeqPreviewRow, RafeeqPreviewOption } from "./preview.ts";
import type { ExportReasonCode } from "../validation.ts";

/** The canonical native Rafeeq columns (the audited template — the contract). */
export const RAFEEQ_PACKAGE_COLUMNS = RAFEEQ_NATIVE_HEADERS;

/** The legacy 10-column template's "new product" marker — retained ONLY for the
 *  durable rafeeq_package_items.rafeeq_id_sent history records. The native
 *  product_id CELL for a new record is BLANK (ids are never invented). */
export const RAFEEQ_NEW_MARKER = "new product";

export { PACKAGE_LIMITS };

/**
 * Rafeeq export modes. UPDATES is intentionally NOT here: there is no durable
 * per-listing export snapshot for the legacy modes, so a changed-listing diff
 * cannot be proven. (The FULLSYNC pending model has its own proven
 * OPTION-UPDATE detection via delivery fingerprints — see fullsync.ts.)
 */
export type RafeeqGenerationMode = "all" | "new" | "selected";
export const RAFEEQ_UPDATES_SUPPORTED = false;

/** Row key of a product row (the product id — product grain). */
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
 * Resolve which PRODUCTS enter the package. BLOCKED products (incl. needs_review
 * conflicts and unresolved option pricing) are ALWAYS excluded.
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

// ── image plan (PRIMARY ONLY, parent-SKU-named) ───────────────────────────────
//
// OWNER CONTRACT (RAFEEQ IMAGES — PRIMARY ONLY): Rafeeq supports exactly ONE
// image per product. Every package carries ONLY the canonical PRIMARY image of
// each included parent product — gallery images and variant images are NEVER
// planned, fetched or packaged for Rafeeq. Option products share the one
// parent primary; options never add images. The canonical primary URL is used
// VERBATIM (no thumbnail/resize variants) and its bytes are packaged exactly
// as downloaded (STORE — no recompression), so the maximum available quality
// is preserved.
export interface PlannedImage { filename: string; sourceUrl: string; kind: "primary" | "gallery" }
export interface RowImagePlan { rowKey: string; sku: string; primary: PlannedImage | null; gallery: PlannedImage[] }

export function planRowImages(r: RafeeqPreviewRow): RowImagePlan {
  const rowKey = previewRowKey(r);
  const sku = r.sku;
  const primaryUrl = typeof r.primaryImageUrl === "string" ? r.primaryImageUrl.trim() : "";
  const ext = extensionFromUrl(primaryUrl || null);
  const primary: PlannedImage | null = sku && primaryUrl ? { filename: primaryImageName(sku, ext), sourceUrl: primaryUrl, kind: "primary" } : null;
  // gallery stays an EMPTY plan by contract — the type is kept so the shared
  // integrity checker still compiles, but nothing ever populates it.
  return { rowKey, sku, primary, gallery: [] };
}

export function primaryFilenameFor(sku: string, ext: string): string {
  return primaryImageName(sku, normalizeExtension(ext));
}

/**
 * Deterministic post-sanitization filename collision detection. Returns the
 * set of primary filenames shared by more than one PRODUCT — the generator
 * BLOCKS package generation if any exist.
 */
export function detectFilenameCollisions(primaryFilenames: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const f of primaryFilenames) counts.set(f.toLowerCase(), (counts.get(f.toLowerCase()) ?? 0) + 1);
  return [...counts.entries()].filter(([, n]) => n > 1).map(([f]) => f).sort();
}

// ── native package rows (ONE logical product → 1..N physical rows) ────────────

export interface RafeeqPackageOption {
  nameEn: string;
  nameAr: string;
  /** option_price cell: 0 when the parent price covers every option; the FULL
   *  effective canonical price under PRICE ON SELECTION (never a delta). */
  price: number;
  sortOrder: number;
}

/** One PRODUCT of the outbound file (expands to its physical rows in the AoA). */
export interface RafeeqPackageRow {
  categoryKey: string | null;    // canonical category name (registry lookup key)
  nameEn: string;
  nameAr: string;
  /** product_price cell — emitted as TEXT (the audited workbook stores it so);
   *  null + priceOnSelection ⇒ the literal "PRICE ON SELECTION" sentinel. */
  price: number | null;
  priceOnSelection: boolean;
  descriptionEn: string;
  descriptionAr: string;
  imageName: string;   // packaged parent-image filename — shared by option rows
  /** BARCODE cell = canonical PARENT product SKU (owner rule). */
  barcode: string;
  /** product_id cell: resolved ECL id, or "" for a new record (never invented). */
  rafeeqId: string;
  groupNameEn: string;
  groupNameAr: string;
  options: RafeeqPackageOption[];
}

/** Project one exportable preview product → its outbound package product. */
export function toPackageRow(r: RafeeqPreviewRow, imageFilename: string): RafeeqPackageRow {
  return {
    categoryKey: r.category,
    nameEn: r.title,               // PARENT title — never "{parent} — {option}"
    nameAr: r.titleAr,
    price: r.price,
    priceOnSelection: r.priceOnSelection,
    descriptionEn: r.descriptionEn,
    descriptionAr: r.descriptionAr,
    imageName: imageFilename,      // ONE packaged file per product
    barcode: r.barcode ?? "",
    rafeeqId: r.rafeeqId ?? "",    // blank ⇒ new record (ids never invented)
    groupNameEn: r.groupNameEn,
    groupNameAr: r.groupNameAr,
    options: r.options.map((o: RafeeqPreviewOption) => ({
      nameEn: o.nameEn,
      nameAr: o.nameAr,
      // Owner rule: uniform price ⇒ 0 (covered by product_price); differing
      // prices ⇒ the FULL effective canonical price (never a delta).
      price: r.priceOnSelection ? (o.effectivePrice ?? 0) : 0,
      sortOrder: o.sortOrder,
    })),
  };
}

const txt = (v: string): AoaCell => sanitizeSpreadsheetText(v);
const priceText = (v: number | null): AoaCell => (typeof v === "number" && Number.isFinite(v) ? String(v) : "");

/** The shared parent cells of one product (identical on every repeated row). */
function parentCells(r: RafeeqPackageRow): AoaCell[] {
  // The resolved registry KEY is the live Rafeeq category name — for exact
  // matches it equals the (apostrophe-folded) canonical name; for an approved
  // alias (e.g. "Summer And Camping Supplies") it is the live name
  // ("Summer Essentials") that the export must carry.
  const catKey = rafeeqCategoryKeyByName(r.categoryKey);
  const cat = catKey === undefined ? undefined : rafeeqCategoryByName(catKey);
  const cells: AoaCell[] = new Array(RAFEEQ_NATIVE_HEADERS.length).fill("");
  cells[NATIVE_COL.categoryId] = cat ? cat.id : "";
  cells[NATIVE_COL.categoryNameEn] = cat && catKey !== undefined ? txt(catKey) : "";
  cells[NATIVE_COL.categoryNameAr] = cat ? txt(cat.ar) : "";
  cells[NATIVE_COL.categoryStatus] = cat ? cat.status : "";
  cells[NATIVE_COL.subcategoryId] = cat?.sub ? cat.sub.id : "";
  cells[NATIVE_COL.subcategoryNameEn] = cat?.sub ? txt(cat.sub.en) : "";
  cells[NATIVE_COL.subcategoryNameAr] = cat?.sub ? txt(cat.sub.ar) : "";
  cells[NATIVE_COL.subcategoryStatus] = cat?.sub ? cat.sub.status : "";
  // subsubcategory columns 8–11 stay blank (blank across the entire audited workbook)
  cells[NATIVE_COL.productId] = r.rafeeqId; // "" ⇒ new record
  cells[NATIVE_COL.productNameEn] = txt(r.nameEn);
  cells[NATIVE_COL.productNameAr] = txt(r.nameAr);
  cells[NATIVE_COL.productDescriptionEn] = txt(r.descriptionEn);
  cells[NATIVE_COL.productDescriptionAr] = txt(r.descriptionAr);
  cells[NATIVE_COL.productStatus] = RAFEEQ_PRODUCT_DEFAULTS.productStatus;
  cells[NATIVE_COL.productAvailability] = RAFEEQ_PRODUCT_DEFAULTS.productAvailability;
  cells[NATIVE_COL.active] = RAFEEQ_PRODUCT_DEFAULTS.active;
  cells[NATIVE_COL.productPrice] = r.priceOnSelection ? RAFEEQ_PRICE_ON_SELECTION : priceText(r.price); // TEXT — audited convention
  cells[NATIVE_COL.barcode] = r.barcode;               // canonical PARENT SKU
  cells[NATIVE_COL.posId] = "";                         // blank across the audited workbook
  cells[NATIVE_COL.preparationTime] = RAFEEQ_PRODUCT_DEFAULTS.preparationTime;
  cells[NATIVE_COL.productImage] = r.imageName;         // one packaged parent file
  cells[NATIVE_COL.groups] = r.options.length > 0 ? 1 : 0;
  return cells;
}

/**
 * Expand the package products into the physical AoA on the audited template:
 * header row + 1 row per simple product + 1 row PER OPTION for option products.
 */
export function buildRafeeqXlsxAoa(rows: readonly RafeeqPackageRow[]): AoaCell[][] {
  const out: AoaCell[][] = [RAFEEQ_NATIVE_HEADERS.slice()];
  for (const r of rows) {
    const base = parentCells(r);
    if (r.options.length === 0) {
      out.push(base);
      continue;
    }
    for (const o of r.options) {
      const cells = base.slice();
      cells[NATIVE_COL.groupId] = "";                       // never invented
      cells[NATIVE_COL.groupNameEn] = txt(r.groupNameEn);
      cells[NATIVE_COL.groupNameAr] = txt(r.groupNameAr);
      cells[NATIVE_COL.maxSelection] = RAFEEQ_GROUP_DEFAULTS.maxSelection;
      cells[NATIVE_COL.minSelection] = RAFEEQ_GROUP_DEFAULTS.minSelection;
      cells[NATIVE_COL.freeSelection] = RAFEEQ_GROUP_DEFAULTS.freeSelection;
      cells[NATIVE_COL.groupStatus] = RAFEEQ_GROUP_DEFAULTS.groupStatus;
      cells[NATIVE_COL.groupSortOrder] = RAFEEQ_GROUP_DEFAULTS.groupSortOrder;
      cells[NATIVE_COL.groupDesignType] = RAFEEQ_GROUP_DEFAULTS.groupDesignType;
      cells[NATIVE_COL.optionId] = "";                      // never invented
      cells[NATIVE_COL.optionNameEn] = txt(o.nameEn);
      cells[NATIVE_COL.optionNameAr] = txt(o.nameAr);
      cells[NATIVE_COL.optionPrice] = o.price;
      cells[NATIVE_COL.optionSortOrder] = o.sortOrder;
      out.push(cells);
    }
  }
  return out;
}

/** Physical spreadsheet rows a set of package products occupies. */
export function physicalRowCount(rows: readonly RafeeqPackageRow[]): number {
  return rows.reduce((acc, r) => acc + Math.max(1, r.options.length), 0);
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
