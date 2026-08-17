// INT.2B.2 — Talabat outbound package PLAN (PURE).
//
// Transforms the ALREADY-CERTIFIED INT.2B preview rows (buildTalabatPreview)
// into the plan for the downloadable package: the XLSX rows (AoA), the ordered
// SKU-named image entries, the referential-integrity check, and the manifest.
// It REUSES the certified template columns (TALABAT_HEADERS) and the INT.2A
// image-naming contract — it never re-flattens, never re-derives SKU/barcode/
// title/image resolution, and never emits a parent row (those decisions were
// made once, in the preview). It performs NO I/O: no xlsx serialization, no
// zip, no fetch, no DB — the server module does that. Framework-free so
// node:test loads it directly.

import { TALABAT_HEADERS } from "../../talabat/export.ts";
import {
  primaryImageName,
  additionalImageName,
  variantImageName,
  extensionFromUrl,
  normalizeExtension,
} from "../image-naming.ts";
import type { TalabatPreviewRow } from "./preview.ts";
import type { ExportReasonCode } from "../validation.ts";

/** The canonical Talabat sheet columns (REUSED from the certified template). */
export const TALABAT_PACKAGE_COLUMNS = TALABAT_HEADERS;

/** Column indexes that MUST be stored as spreadsheet TEXT (never numeric). */
export const TALABAT_TEXT_COLUMNS = [
  0, // SKU               — identity; keep leading zeros, never scientific notation
  1, // Barcode           — long numeric; TEXT so 6291041500213 never becomes 6.29E+12
  9, // New Image Filename
] as const;

/** Column index of the numeric price. */
export const TALABAT_PRICE_COLUMN = 2;

/**
 * Practical limits for one bounded, server-side generation (§24). The generator
 * holds each image binary only long enough to place it in the archive; these
 * caps keep peak memory + wall-clock predictable on the serverless runtime.
 */
export const TALABAT_PACKAGE_LIMITS = {
  /** Max sellable rows packaged in a single run. */
  maxRows: 5000,
  /** Max additional (gallery) images packaged per simple product. */
  maxGalleryPerRow: 8,
  /** Max bytes accepted for one image before it is skipped as unsafe/oversized. */
  maxImageBytes: 15 * 1024 * 1024,
} as const;

export type TalabatGenerationMode = "ready" | "selected";

/** Stable key for one sellable preview row (matches the preview UI row key). */
export function previewRowKey(r: Pick<TalabatPreviewRow, "internalProductId" | "variantId">): string {
  return `${r.internalProductId}:${r.variantId ?? "-"}`;
}

/** A row is exportable when it is NOT blocked (READY or WARNING). Never BLOCKED. */
export function isExportableRow(r: Pick<TalabatPreviewRow, "status">): boolean {
  return r.status === "READY" || r.status === "WARNING";
}

/**
 * True when the row's packaged image is the product-level image shared onto a
 * variant (the disclosed interim behavior — the catalog has no variant-media
 * model yet). Informational only; never blocks. Detected from the certified
 * IMAGE_SHARED_FROM_PRODUCT warning so preview/package/manifest agree exactly.
 */
export function usesSharedProductImage(r: Pick<TalabatPreviewRow, "reasons">): boolean {
  return (r.reasons ?? []).some((x) => x.code === "IMAGE_SHARED_FROM_PRODUCT");
}

export interface GenerationSelection {
  mode: TalabatGenerationMode;
  /** Row keys to include when mode === "selected" (previewRowKey values). */
  selectedKeys?: readonly string[];
}

export interface GenerationSet {
  /** Rows that will be packaged — never contains a BLOCKED row. */
  included: TalabatPreviewRow[];
  /** Blocked rows, always excluded (never silently packaged). */
  excludedBlocked: TalabatPreviewRow[];
  /** Rows dropped only because they were outside the selection (selected mode). */
  excludedUnselected: TalabatPreviewRow[];
  counts: {
    total: number;
    ready: number;
    warnings: number;
    blocked: number;
    includedRows: number;
  };
}

/**
 * Resolve which sellable rows enter the package. BLOCKED rows are ALWAYS
 * excluded — even if explicitly selected — so no mode can ever leak a blocked
 * row (§10/§20/§26). In "ready" mode every exportable row is included; in
 * "selected" mode only exportable rows whose key is in `selectedKeys`.
 */
export function resolveGenerationSet(
  rows: readonly TalabatPreviewRow[],
  selection: GenerationSelection,
): GenerationSet {
  const wanted =
    selection.mode === "selected" ? new Set(selection.selectedKeys ?? []) : null;

  const included: TalabatPreviewRow[] = [];
  const excludedBlocked: TalabatPreviewRow[] = [];
  const excludedUnselected: TalabatPreviewRow[] = [];
  let ready = 0;
  let warnings = 0;
  let blocked = 0;

  for (const r of rows) {
    if (r.status === "READY") ready++;
    else if (r.status === "WARNING") warnings++;
    else if (r.status === "BLOCKED") blocked++;

    if (!isExportableRow(r)) {
      if (r.status === "BLOCKED") excludedBlocked.push(r);
      continue;
    }
    if (wanted && !wanted.has(previewRowKey(r))) {
      excludedUnselected.push(r);
      continue;
    }
    included.push(r);
  }

  return {
    included,
    excludedBlocked,
    excludedUnselected,
    counts: { total: rows.length, ready, warnings, blocked, includedRows: included.length },
  };
}

// ── image plan ────────────────────────────────────────────────────────────────

export interface PlannedImage {
  /** SKU-derived filename that will appear in the archive AND the sheet. */
  filename: string;
  /** the retrievable source URL to fetch (never fabricated). */
  sourceUrl: string;
  kind: "primary" | "gallery";
}

export interface RowImagePlan {
  rowKey: string;
  sku: string;
  isVariant: boolean;
  /** the required primary image (null only when there is no retrievable URL). */
  primary: PlannedImage | null;
  /** additional images — SIMPLE products only (variants inherit primary only). */
  gallery: PlannedImage[];
}

/**
 * Deterministic image plan for one exportable row. Filenames derive ONLY from
 * the sellable SKU (never the title, never the parent SKU — the row's `sku` IS
 * the sellable/variant SKU as resolved by the preview). The primary uses the
 * row's own image extension; gallery entries are numbered _2, _3, … A variant
 * gets a primary only — preserving the documented INT.2B image behavior.
 */
export function planRowImages(r: TalabatPreviewRow): RowImagePlan {
  const rowKey = previewRowKey(r);
  const sku = r.sku;
  const primaryUrl = typeof r.primaryImageUrl === "string" ? r.primaryImageUrl.trim() : "";
  const ext = extensionFromUrl(primaryUrl || null);
  const primary: PlannedImage | null =
    sku && primaryUrl
      ? { filename: r.isVariant ? variantImageName(sku, ext) : primaryImageName(sku, ext), sourceUrl: primaryUrl, kind: "primary" }
      : null;

  const gallery: PlannedImage[] = [];
  if (sku && !r.isVariant && Array.isArray(r.galleryImageUrls)) {
    let position = 2; // primary is position 1
    for (const raw of r.galleryImageUrls) {
      if (gallery.length >= TALABAT_PACKAGE_LIMITS.maxGalleryPerRow) break;
      const url = typeof raw === "string" ? raw.trim() : "";
      if (!url) continue;
      const g = additionalImageName(sku, position, extensionFromUrl(url));
      gallery.push({ filename: g, sourceUrl: url, kind: "gallery" });
      position++;
    }
  }
  return { rowKey, sku, isVariant: r.isVariant, primary, gallery };
}

// ── XLSX rows (AoA) ─────────────────────────────────────────────────────────────

/** The resolved outbound payload for one packaged sellable row. */
export interface TalabatPackageRow {
  sku: string;
  barcode: string;
  /** effective price (already discount-aware from the preview); null ⇒ blank. */
  priceQar: number | null;
  discount: string;
  nameEn: string;
  nameAr: string;
  category: string;
  descriptionEn: string;
  descriptionAr: string;
  /** the FINAL primary image filename actually placed in the archive. */
  imageFilename: string;
}

/**
 * Guard a spreadsheet text cell against formula/command injection: a value that
 * begins with = + - @ (or a tab/CR that Excel treats as a formula lead-in) is
 * prefixed with a single apostrophe so the spreadsheet renders it as literal
 * text. Numeric price values are NEVER passed through here, so legitimate
 * numbers are untouched (§14).
 */
export function sanitizeSpreadsheetText(value: string | null | undefined): string {
  const v = value == null ? "" : String(value);
  if (v === "") return "";
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

/**
 * Project one exportable preview row → its outbound package row. `imageFilename`
 * is the FINAL filename decided by the server after image validation, so the
 * XLSX cell always matches the packaged file exactly (§5/§8).
 */
export function toPackageRow(r: TalabatPreviewRow, imageFilename: string): TalabatPackageRow {
  return {
    sku: r.sku,
    barcode: r.barcode ?? "",
    priceQar: r.price,
    discount: "",
    nameEn: r.title,
    nameAr: r.titleAr,
    category: r.category ?? "",
    descriptionEn: r.descriptionEn,
    descriptionAr: r.descriptionAr,
    imageFilename,
  };
}

/** One AoA cell: a string (text) or a number (price). */
export type AoaCell = string | number;

/**
 * Build the Talabat sheet as an array-of-arrays: the canonical header row then
 * one row per package row, in the given (deterministic) order. SKU / barcode /
 * image filename are emitted as strings (the server marks them TEXT cells);
 * price is a number (or "" when absent); all free-text is injection-sanitized.
 */
export function buildTalabatXlsxAoa(rows: readonly TalabatPackageRow[]): AoaCell[][] {
  const out: AoaCell[][] = [TALABAT_PACKAGE_COLUMNS.slice()];
  for (const r of rows) {
    out.push([
      r.sku, // TEXT
      r.barcode, // TEXT
      typeof r.priceQar === "number" && Number.isFinite(r.priceQar) ? r.priceQar : "", // NUMBER
      sanitizeSpreadsheetText(r.discount),
      sanitizeSpreadsheetText(r.nameEn),
      sanitizeSpreadsheetText(r.nameAr),
      sanitizeSpreadsheetText(r.category),
      sanitizeSpreadsheetText(r.descriptionEn),
      sanitizeSpreadsheetText(r.descriptionAr),
      r.imageFilename, // TEXT
    ]);
  }
  return out;
}

// ── referential integrity (XLSX ↔ ZIP) ──────────────────────────────────────────

export interface PackagedFile {
  name: string;
  kind: "primary" | "gallery";
  /** for gallery files: the primary filename they belong to. */
  ownerPrimary?: string;
}

export interface IntegrityResult {
  ok: boolean;
  /** XLSX rows whose primary image is NOT present in the archive. */
  missingForRows: string[];
  /** packaged primary images with NO corresponding XLSX row. */
  orphanPrimaries: string[];
  /** packaged gallery images whose owning primary has NO XLSX row. */
  orphanGallery: string[];
}

/**
 * Deterministic XLSX↔ZIP referential-integrity check, run BEFORE the archive is
 * finalized (§8). Every XLSX primary reference must resolve to a packaged
 * primary; no packaged primary may lack an XLSX row; every gallery file must
 * belong to a primary that has an XLSX row.
 */
export function checkReferentialIntegrity(
  xlsxImageRefs: readonly string[],
  packaged: readonly PackagedFile[],
): IntegrityResult {
  const refs = new Set(xlsxImageRefs);
  const packagedPrimaries = new Set(packaged.filter((p) => p.kind === "primary").map((p) => p.name));

  const missingForRows = [...refs].filter((r) => !packagedPrimaries.has(r)).sort();
  const orphanPrimaries = packaged
    .filter((p) => p.kind === "primary" && !refs.has(p.name))
    .map((p) => p.name)
    .sort();
  const orphanGallery = packaged
    .filter((p) => p.kind === "gallery" && (!p.ownerPrimary || !refs.has(p.ownerPrimary)))
    .map((p) => p.name)
    .sort();

  return {
    ok: missingForRows.length === 0 && orphanPrimaries.length === 0 && orphanGallery.length === 0,
    missingForRows,
    orphanPrimaries,
    orphanGallery,
  };
}

// ── pre-generation preview (§11) ────────────────────────────────────────────────

export interface GenerationPlanPreview {
  products: number;
  sellableRows: number;
  simpleProducts: number;
  variantRows: number;
  ready: number;
  warnings: number;
  blocked: number;
  /** rows that WOULD be packaged for this mode/selection (never blocked). */
  rowsIncluded: number;
  /** primary + gallery images the package will contain for the included rows. */
  imagesExpected: number;
  /** included rows whose image is the product image shared onto a variant (disclosed). */
  imagesSharedFromProduct: number;
  /** grouped BLOCKING reason counts across blocked rows. */
  blockersByReason: Partial<Record<ExportReasonCode, number>>;
}

/**
 * The operator-facing pre-generation summary (§11): what the package WILL
 * contain before a single file is produced. Pure — computed straight from the
 * certified preview rows and the chosen mode/selection.
 */
export function previewGenerationPlan(
  rows: readonly TalabatPreviewRow[],
  selection: GenerationSelection,
): GenerationPlanPreview {
  const set = resolveGenerationSet(rows, selection);
  const productIds = new Set<string>();
  let simpleProducts = 0;
  let variantRows = 0;
  for (const r of rows) {
    productIds.add(r.internalProductId);
    if (r.isVariant) variantRows++;
    else simpleProducts++;
  }

  let imagesExpected = 0;
  let imagesSharedFromProduct = 0;
  for (const r of set.included) {
    const plan = planRowImages(r);
    if (plan.primary) imagesExpected += 1;
    imagesExpected += plan.gallery.length;
    if (usesSharedProductImage(r)) imagesSharedFromProduct += 1;
  }

  const blockersByReason: Partial<Record<ExportReasonCode, number>> = {};
  for (const r of set.excludedBlocked) {
    for (const reason of r.reasons) {
      if (!reason.blocking) continue;
      blockersByReason[reason.code] = (blockersByReason[reason.code] ?? 0) + 1;
    }
  }

  return {
    products: productIds.size,
    sellableRows: rows.length,
    simpleProducts,
    variantRows,
    ready: set.counts.ready,
    warnings: set.counts.warnings,
    blocked: set.counts.blocked,
    rowsIncluded: set.counts.includedRows,
    imagesExpected,
    imagesSharedFromProduct,
    blockersByReason,
  };
}

// ── manifest (§12) ──────────────────────────────────────────────────────────────

export interface TalabatManifestInput {
  destination: string;
  generatedAt: string;
  actor: string | null;
  simpleProductCount: number;
  variantRowCount: number;
  sellableRowCount: number;
  imageCount: number;
  warningCount: number;
  /** packaged rows whose image is the product image shared onto a variant (disclosed). */
  imageSharedFromProductCount: number;
  excludedBlockedCount: number;
  outputFilename: string;
  previewReference: Record<string, unknown>;
}

/**
 * Build the manifest.json payload (§12). Contains only counts + provenance —
 * never secrets, credentials, internal hosts, or raw catalog rows.
 */
export function buildManifest(input: TalabatManifestInput): Record<string, unknown> {
  return {
    schema: "talabat-export-manifest/1",
    destination: input.destination,
    generated_at: input.generatedAt,
    actor: input.actor,
    simple_product_count: input.simpleProductCount,
    variant_row_count: input.variantRowCount,
    sellable_row_count: input.sellableRowCount,
    image_count: input.imageCount,
    warning_count: input.warningCount,
    image_shared_from_product_count: input.imageSharedFromProductCount,
    excluded_blocked_count: input.excludedBlockedCount,
    output_filename: input.outputFilename,
    preview_reference: input.previewReference,
  };
}

/** Extension a packaged image should use given the URL and a validated MIME. */
export function resolvePackagedExtension(sourceUrl: string, contentType: string | null): string {
  const fromMime = mimeToExt(contentType);
  return fromMime ?? extensionFromUrl(sourceUrl);
}

/**
 * Sniff the real image type from the leading magic bytes (§7 "actual content is
 * an image"). Returns a canonical extension, or null when the bytes are not a
 * recognized image — which the caller treats as an unsafe/mismatched file and
 * skips. Pure: bytes in → ext out.
 */
export function sniffImageExtension(bytes: Uint8Array | null | undefined): string | null {
  if (!bytes || bytes.length < 12) return null;
  const b = bytes;
  // JPEG: FF D8 FF
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  // GIF: "GIF8"
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "gif";
  // RIFF....WEBP
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "webp";
  // ISO-BMFF (AVIF / HEIC): "....ftyp" then a brand at bytes 8..11
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]).toLowerCase();
    if (brand.startsWith("avif") || brand.startsWith("avis")) return "avif";
    if (brand.startsWith("heic") || brand.startsWith("heif") || brand.startsWith("mif1")) return "heic";
  }
  return null;
}

/** Map a validated image content-type to a canonical extension (null if unknown). */
export function mimeToExt(contentType: string | null | undefined): string | null {
  const ct = String(contentType ?? "").toLowerCase().split(";")[0].trim();
  switch (ct) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/avif":
      return "avif";
    default:
      return null;
  }
}

/** Recompute a row's primary filename with a (possibly MIME-corrected) extension. */
export function primaryFilenameFor(r: Pick<TalabatPreviewRow, "sku" | "isVariant">, ext: string): string {
  const e = normalizeExtension(ext);
  return r.isVariant ? variantImageName(r.sku, e) : primaryImageName(r.sku, e);
}
