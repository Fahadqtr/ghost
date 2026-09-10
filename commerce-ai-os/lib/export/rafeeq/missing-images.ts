// RAFEEQ MISSING-IMAGES REQUEST (PURE).
//
// Rafeeq sends a workbook naming the products whose images are missing on
// THEIR side: sheet "data" with product_id / product_name_english / barcode.
// The `barcode` column carries OUR SKU, not a GTIN — the column name is theirs
// and is not renamed here, because the file is their artefact.
//
// This module answers three questions and nothing else:
//   1. which requested row is which of our products (identity);
//   2. what image we actually hold for it (availability);
//   3. which file each of those becomes in the delivered archive (naming).
//
// It performs NO I/O: bytes, downloads and archives belong to the caller. That
// is what makes every rule below testable against fixtures rather than against
// production.
//
// Two rules are inherited rather than reinvented:
//   • the archive is PRIMARY-ONLY — exactly one file per product, the same
//     contract lib/export/rafeeq/package-job.ts already ships under;
//   • the extension comes from the BYTES (sniffImageExtension), never from the
//     URL's spelling of it. On 2026-09-10 that mattered for 37 of 156 requested
//     products whose stored URL ends ".jpg" over PNG bytes.

import { sanitizeSkuForFilename } from "../image-naming.ts";

/** One row of Rafeeq's workbook, already read out of the sheet. */
export interface RafeeqMissingImagesRow {
  rafeeqProductId: number;
  productNameEnglish: string;
  /** Rafeeq's column name. Holds OUR SKU. */
  barcode: string;
}

/** One of our products, as far as this module needs to know it. */
export interface RafeeqMissingImagesCandidate {
  productId: string;
  sku: string;
  nameEn: string;
  /** Usable image URLs, ALREADY ordered primary-first by the caller's resolver. */
  imageUrls: readonly string[];
}

export type RafeeqMatchStatus = "MATCHED" | "AMBIGUOUS" | "NOT_FOUND";
export type RafeeqMissingImageAction =
  | "READY_FOR_IMAGE_DELIVERY"
  | "NO_IMAGE_IN_OUR_CATALOG"
  | "MANUAL_REVIEW";

export interface RafeeqMissingImageDecision {
  rafeeqProductId: number;
  rafeeqProductName: string;
  rafeeqSku: string;
  matchStatus: RafeeqMatchStatus;
  ourProductId: string | null;
  ourProductTitle: string | null;
  primaryImageAvailable: boolean;
  galleryImageCount: number;
  totalUsableImages: number;
  action: RafeeqMissingImageAction;
  /** Why this row is not ready. null when it is. */
  reason: string | null;
}

/** Request-file problems worth reporting BEFORE any matching is attempted. */
export interface RafeeqMissingImagesRequestAudit {
  rows: number;
  duplicateProductIds: number[];
  duplicateSkus: string[];
  missingProductIds: number;
  missingSkus: number;
  missingNames: number;
}

const norm = (s: string): string => String(s ?? "").trim().toLowerCase();

export function auditMissingImagesRequest(
  rows: readonly RafeeqMissingImagesRow[],
): RafeeqMissingImagesRequestAudit {
  const pidSeen = new Map<number, number>();
  const skuSeen = new Map<string, number>();
  let missingProductIds = 0, missingSkus = 0, missingNames = 0;
  for (const r of rows) {
    const pid = r.rafeeqProductId;
    if (!Number.isFinite(pid) || pid <= 0) missingProductIds += 1;
    else pidSeen.set(pid, (pidSeen.get(pid) ?? 0) + 1);
    const sku = norm(r.barcode);
    if (sku === "") missingSkus += 1;
    else skuSeen.set(sku, (skuSeen.get(sku) ?? 0) + 1);
    if (String(r.productNameEnglish ?? "").trim() === "") missingNames += 1;
  }
  return {
    rows: rows.length,
    duplicateProductIds: [...pidSeen].filter(([, n]) => n > 1).map(([p]) => p).sort((a, b) => a - b),
    duplicateSkus: [...skuSeen].filter(([, n]) => n > 1).map(([s]) => s).sort(),
    missingProductIds, missingSkus, missingNames,
  };
}

/**
 * Decide each requested row against our catalogue.
 *
 * Identity is the EXACT SKU, case-insensitively, and nothing else. A product
 * NAME never matches: Rafeeq's titles are edited on their side, and two of our
 * products can share one. A SKU held by more than one of our products is
 * AMBIGUOUS and is never auto-packaged — the owner decides which is meant.
 */
export function decideMissingImages(
  rows: readonly RafeeqMissingImagesRow[],
  candidates: readonly RafeeqMissingImagesCandidate[],
): RafeeqMissingImageDecision[] {
  const bySku = new Map<string, RafeeqMissingImagesCandidate[]>();
  for (const c of candidates) {
    const k = norm(c.sku);
    if (k === "") continue;
    const list = bySku.get(k);
    if (list) list.push(c); else bySku.set(k, [c]);
  }

  return rows.map((r) => {
    const sku = String(r.barcode ?? "").trim();
    const hits = bySku.get(norm(sku)) ?? [];
    const base = {
      rafeeqProductId: r.rafeeqProductId,
      rafeeqProductName: String(r.productNameEnglish ?? ""),
      rafeeqSku: sku,
    };
    if (hits.length === 0) {
      return {
        ...base, matchStatus: "NOT_FOUND" as const,
        ourProductId: null, ourProductTitle: null,
        primaryImageAvailable: false, galleryImageCount: 0, totalUsableImages: 0,
        action: "MANUAL_REVIEW" as const,
        reason: "no product in our catalogue carries this SKU",
      };
    }
    if (hits.length > 1) {
      return {
        ...base, matchStatus: "AMBIGUOUS" as const,
        ourProductId: null, ourProductTitle: null,
        primaryImageAvailable: false, galleryImageCount: 0, totalUsableImages: 0,
        action: "MANUAL_REVIEW" as const,
        reason: `${hits.length} of our products carry this SKU`,
      };
    }
    const c = hits[0];
    const urls = c.imageUrls.filter((u) => typeof u === "string" && u.trim() !== "");
    const total = urls.length;
    return {
      ...base, matchStatus: "MATCHED" as const,
      ourProductId: c.productId, ourProductTitle: c.nameEn,
      primaryImageAvailable: total > 0,
      galleryImageCount: Math.max(0, total - 1),
      totalUsableImages: total,
      action: total > 0 ? ("READY_FOR_IMAGE_DELIVERY" as const) : ("NO_IMAGE_IN_OUR_CATALOG" as const),
      reason: total > 0 ? null : "matched, but we hold no usable image",
    };
  });
}

/** One archive entry: the product, its source, and the name it ships under. */
export interface RafeeqMissingImageEntry {
  rafeeqProductId: number;
  sku: string;
  productName: string;
  sourceUrl: string;
  filename: string;
}

/**
 * The delivered filename: `<rafeeqProductId>__<SKU>.<ext>`.
 *
 * BOTH keys, deliberately. Rafeeq's own product ids for this request
 * (698933xxx–698934xxx) appear nowhere in our channel mapping — ours are an
 * older 691300xxx generation — so a SKU-only name would leave them matching by
 * hand, and an id-only name would leave US unable to check the file is right.
 * `ext` must come from the image BYTES, not from the source URL.
 */
export function missingImageFilename(rafeeqProductId: number, sku: string, ext: string): string {
  const e = String(ext ?? "").trim().toLowerCase().replace(/^\.+/, "");
  const safeExt = /^[a-z0-9]+$/.test(e) ? e : "jpg";
  return `${rafeeqProductId}__${sanitizeSkuForFilename(sku)}.${safeExt}`;
}

/**
 * The package plan: PRIMARY ONLY, and only for rows that are ready.
 *
 * `sniffedExtFor` receives the row's primary source URL and returns the format
 * its bytes actually are — null means the caller could not fetch or identify
 * it, and that row is dropped from the archive rather than shipped unnamed.
 */
export function planMissingImagePackage(
  decisions: readonly RafeeqMissingImageDecision[],
  primaryUrlOf: (decision: RafeeqMissingImageDecision) => string | null,
  sniffedExtFor: (sourceUrl: string) => string | null,
): { entries: RafeeqMissingImageEntry[]; droppedUnreadable: number } {
  const entries: RafeeqMissingImageEntry[] = [];
  let droppedUnreadable = 0;
  for (const d of decisions) {
    if (d.action !== "READY_FOR_IMAGE_DELIVERY") continue;
    const url = primaryUrlOf(d);
    if (url === null || url.trim() === "") { droppedUnreadable += 1; continue; }
    const ext = sniffedExtFor(url);
    if (ext === null) { droppedUnreadable += 1; continue; }
    entries.push({
      rafeeqProductId: d.rafeeqProductId,
      sku: d.rafeeqSku,
      productName: d.ourProductTitle ?? d.rafeeqProductName,
      sourceUrl: url,
      filename: missingImageFilename(d.rafeeqProductId, d.rafeeqSku, ext),
    });
  }
  return { entries, droppedUnreadable };
}

export const MISSING_IMAGES_MANIFEST_HEADERS = [
  "RAFEEQ_PRODUCT_ID", "RAFEEQ_SKU", "PRODUCT_NAME",
  "PRIMARY_IMAGE_FILENAME", "ADDITIONAL_IMAGE_FILENAMES", "IMAGE_COUNT",
] as const;

/**
 * The manifest rows. ADDITIONAL_IMAGE_FILENAMES is deliberately BLANK: the
 * archive is primary-only, and naming a file it does not contain would make
 * the manifest a lie the recipient discovers on import.
 */
export function buildMissingImagesManifest(
  entries: readonly RafeeqMissingImageEntry[],
): (string | number)[][] {
  return entries.map((e) => [e.rafeeqProductId, e.sku, e.productName, e.filename, "", 1]);
}

export const MISSING_IMAGES_REVIEW_HEADERS = [
  "RAFEEQ_PRODUCT_ID", "RAFEEQ_PRODUCT_NAME", "RAFEEQ_SKU", "MATCH_STATUS",
  "OUR_PRODUCT_ID", "OUR_PRODUCT_TITLE", "PRIMARY_IMAGE_AVAILABLE",
  "GALLERY_IMAGE_COUNT", "TOTAL_USABLE_IMAGES", "ACTION",
] as const;

/** One review row per REQUESTED item — including the ones we cannot serve. */
export function buildMissingImagesReview(
  decisions: readonly RafeeqMissingImageDecision[],
): (string | number)[][] {
  return decisions.map((d) => [
    d.rafeeqProductId, d.rafeeqProductName, d.rafeeqSku, d.matchStatus,
    d.ourProductId ?? "", d.ourProductTitle ?? "",
    d.primaryImageAvailable ? "YES" : "NO",
    d.galleryImageCount, d.totalUsableImages, d.action,
  ]);
}

export type RafeeqMissingImagesBlock =
  | "unrequested_file_in_package"
  | "unmatched_product_in_package"
  | "duplicate_package_path"
  | "manifest_file_missing_from_archive"
  | "archive_file_missing_from_manifest";

/**
 * The audit the owner signs off on: the archive contains exactly the files the
 * manifest names, each traceable to a REQUESTED row that matched safely.
 *
 * Every check is stated against the request itself, so a package assembled by
 * some other path cannot pass by agreeing with its own plan.
 */
export function verifyMissingImagesPackage(
  request: readonly RafeeqMissingImagesRow[],
  decisions: readonly RafeeqMissingImageDecision[],
  entries: readonly RafeeqMissingImageEntry[],
  archiveFilenames: readonly string[],
): RafeeqMissingImagesBlock[] {
  const blocks = new Set<RafeeqMissingImagesBlock>();

  const requested = new Set(request.map((r) => `${r.rafeeqProductId}\t${norm(r.barcode)}`));
  const readyIds = new Set(
    decisions.filter((d) => d.action === "READY_FOR_IMAGE_DELIVERY").map((d) => d.rafeeqProductId));

  for (const e of entries) {
    if (!requested.has(`${e.rafeeqProductId}\t${norm(e.sku)}`)) blocks.add("unrequested_file_in_package");
    if (!readyIds.has(e.rafeeqProductId)) blocks.add("unmatched_product_in_package");
  }

  const lower = entries.map((e) => e.filename.toLowerCase());
  if (new Set(lower).size !== lower.length) blocks.add("duplicate_package_path");

  const archive = new Set(archiveFilenames);
  const planned = new Set(entries.map((e) => e.filename));
  for (const f of planned) if (!archive.has(f)) blocks.add("manifest_file_missing_from_archive");
  for (const f of archive) if (!planned.has(f)) blocks.add("archive_file_missing_from_manifest");

  return [...blocks].sort();
}
