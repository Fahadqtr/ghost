// RAFEEQ.FULLSYNC.1 — canonical catalog → Rafeeq file-sync PLAN (PURE).
//
// The main catalog is the single source of truth for Rafeeq. This module holds
// the pure decisions for the two file-sync packages and the durable sent-state
// derivation:
//
//   • FULL  — every currently exportable canonical product, one row each. A row
//     whose ONLY blocker is the contested-identity review (IDENTITY_NEEDS_REVIEW)
//     is INCLUDED with the literal "new product" marker (its contested id is
//     never surfaced, never guessed) — every true blocker (missing/duplicate
//     SKU, blocking barcode duplicate, missing image/title, stopped lifecycle,
//     filename collision, cross-product identity conflict) still excludes.
//   • NEW   — the PENDING sellable rows only (pendingNewRows): exportable for
//     Rafeeq AND not contained in any package the owner explicitly marked SENT —
//     the durable delivery baseline, not an identity proxy. Sent-state is
//     tracked at SELLABLE grain (product_id + nullable variant_id), so a new
//     variant added to an already-sent product becomes pending on its own while
//     its already-sent siblings stay non-pending. Identity does NOT define
//     newness: a mapped-but-never-sent row is pending, an unmapped row that was
//     sent is not. products.created_at is NEVER consulted.
//
// Sent state is durable + explicit: only a package row with sent_at != null
// counts. Generating or downloading a package NEVER changes the pending queue.
// No I/O — node:test loads this directly.

import { RAFEEQ_NEW_MARKER, type RafeeqPackageRow } from "./package.ts";
import { sellableRowKey, type RafeeqPreviewRow } from "./preview.ts";

/** File-sync package modes (durable, uppercase — matches rafeeq_packages.mode). */
export type RafeeqFullSyncMode = "FULL" | "NEW";
export const RAFEEQ_FULLSYNC_MODES: readonly RafeeqFullSyncMode[] = ["FULL", "NEW"];

// ── durable sent-state derivation ─────────────────────────────────────────────

/** A durable package record (normalized from rafeeq_packages). */
export interface RafeeqPackageRecord {
  id: string;
  mode: RafeeqFullSyncMode;
  outputFilename: string;
  productCount: number;
  imageCount: number;
  generatedAt: string | null;
  generatedBy: string | null;
  sentAt: string | null;
  sentBy: string | null;
  /** set when a later FULL package replaced this (still unsent) one. */
  supersededAt?: string | null;
}

/** A durable package item (normalized from rafeeq_package_items) — SELLABLE grain. */
export interface RafeeqPackageItemRecord {
  packageId: string;
  productId: string;
  /** null for a simple-product row; the variant id for a variant row. */
  variantId: string | null;
  sku: string;
}

/** The durable sellable identity of a preview row (product / product::variant). */
export function sellableKeyOfRow(r: Pick<RafeeqPreviewRow, "internalProductId" | "variantId">): string {
  return sellableRowKey(r.internalProductId, r.variantId);
}

/**
 * The set of SELLABLE keys (product / product::variant) contained in any package
 * the owner explicitly marked SENT (sent_at != null). This — and ONLY this —
 * clears a sellable row from the pending-NEW queue. Unsent packages contribute
 * nothing. A legacy product-grain item (variant_id null) clears only the
 * product's SIMPLE row — it is never reinterpreted as covering that product's
 * variants.
 */
export function sentSellableKeySet(
  packages: readonly RafeeqPackageRecord[],
  items: readonly RafeeqPackageItemRecord[],
): Set<string> {
  const sentPackageIds = new Set<string>();
  for (const p of packages) if (p.sentAt !== null) sentPackageIds.add(p.id);
  const out = new Set<string>();
  for (const it of items) if (sentPackageIds.has(it.packageId)) out.add(sellableRowKey(it.productId, it.variantId));
  return out;
}

/** True once any package has been explicitly marked sent (the baseline exists). */
export function hasSentBaseline(packages: readonly RafeeqPackageRecord[]): boolean {
  return packages.some((p) => p.sentAt !== null);
}

// ── FULL eligibility ──────────────────────────────────────────────────────────

/**
 * Whether a canonical product row enters the FULL catalog file. READY/WARNING
 * rows always do. A BLOCKED row is included ONLY when every one of its blocking
 * reasons is IDENTITY_NEEDS_REVIEW — the contested identity does not block the
 * FULL file (the row ships with the "new product" marker; the contested id is
 * never used). Any other blocker (missing/duplicate SKU, blocking barcode
 * duplicate, missing image/title, stopped lifecycle, cross-product identity
 * conflict, filename collision) keeps the row out.
 */
export function isFullIncludable(r: Pick<RafeeqPreviewRow, "status" | "reasons">): boolean {
  if (r.status === "READY" || r.status === "WARNING") return true;
  if (r.status !== "BLOCKED") return false;
  const blocking = r.reasons.filter((x) => x.blocking);
  return blocking.length > 0 && blocking.every((x) => x.code === "IDENTITY_NEEDS_REVIEW");
}

/** A FULL-includable row whose only blocker is the identity review. */
export function isNeedsReviewIncluded(r: Pick<RafeeqPreviewRow, "status" | "reasons">): boolean {
  return r.status === "BLOCKED" && isFullIncludable(r);
}

// ── pending-NEW derivation ────────────────────────────────────────────────────

/**
 * PENDING NEW SELLABLE ROW = currently exportable for Rafeeq (FULL-includable)
 * AND its sellable key is not contained in any SENT package. Derived only —
 * never stored, never based on ECL identity presence, never based on
 * products.created_at. Because the key is sellable-grain, a new variant of an
 * already-sent product is pending on its own; sent siblings stay cleared.
 */
export function pendingNewRows(
  rows: readonly RafeeqPreviewRow[],
  sentSellableKeys: ReadonlySet<string>,
): RafeeqPreviewRow[] {
  return rows.filter((r) => isFullIncludable(r) && !sentSellableKeys.has(sellableKeyOfRow(r)));
}

// ── generation set ────────────────────────────────────────────────────────────

export interface FullSyncGenerationSet {
  included: RafeeqPreviewRow[];
  /** rows kept out by a TRUE blocker (never by the identity review alone). */
  excludedBlocked: RafeeqPreviewRow[];
  /** NEW mode only: includable rows already contained in a sent package. */
  excludedAlreadySent: RafeeqPreviewRow[];
  counts: {
    total: number;
    includable: number;
    trueBlockers: number;
    needsReviewIncluded: number;
    includedRows: number;
  };
}

/** Resolve which rows enter a FULL or NEW package. */
export function resolveFullSyncSet(
  rows: readonly RafeeqPreviewRow[],
  mode: RafeeqFullSyncMode,
  sentSellableKeys: ReadonlySet<string>,
): FullSyncGenerationSet {
  const included: RafeeqPreviewRow[] = [];
  const excludedBlocked: RafeeqPreviewRow[] = [];
  const excludedAlreadySent: RafeeqPreviewRow[] = [];
  let includable = 0;
  let needsReviewIncluded = 0;

  for (const r of rows) {
    if (!isFullIncludable(r)) {
      if (r.status === "BLOCKED") excludedBlocked.push(r);
      continue;
    }
    includable++;
    if (isNeedsReviewIncluded(r)) needsReviewIncluded++;
    if (mode === "NEW" && sentSellableKeys.has(sellableKeyOfRow(r))) {
      excludedAlreadySent.push(r);
      continue;
    }
    included.push(r);
  }

  return {
    included,
    excludedBlocked,
    excludedAlreadySent,
    counts: {
      total: rows.length,
      includable,
      trueBlockers: excludedBlocked.length,
      needsReviewIncluded,
      includedRows: included.length,
    },
  };
}

// ── RAFEEQ ID projection per mode ─────────────────────────────────────────────

/**
 * The RAFEEQ ID cell for a row in a file-sync package. FULL preserves a valid
 * resolved id and marks everything else "new product". NEW forces the marker on
 * EVERY row — a pending product is, by definition, being introduced to Rafeeq
 * as new. An id is never fabricated and a contested id is never emitted (a
 * needs_review row already carries rafeeqId = null in the certified preview).
 */
export function fullSyncRafeeqId(row: Pick<RafeeqPreviewRow, "rafeeqId">, mode: RafeeqFullSyncMode): string {
  if (mode === "NEW") return RAFEEQ_NEW_MARKER;
  return row.rafeeqId ?? RAFEEQ_NEW_MARKER;
}

/** Apply the mode's RAFEEQ ID projection to an already-built package row. */
export function applyFullSyncRafeeqId(
  packageRow: RafeeqPackageRow,
  row: Pick<RafeeqPreviewRow, "rafeeqId">,
  mode: RafeeqFullSyncMode,
): RafeeqPackageRow {
  return { ...packageRow, rafeeqId: fullSyncRafeeqId(row, mode) };
}

// ── canonical row fingerprint (deterministic, dependency-free) ────────────────

/** FNV-1a 32-bit over a string → 8-hex-char token. */
function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Deterministic fingerprint of the canonical fields that the Rafeeq file
 * carries for one product. Two passes (forward + reversed input) so accidental
 * transpositions collide far less than a single 32-bit hash.
 */
export function rowFingerprint(r: RafeeqPreviewRow): string {
  const parts = [
    r.variantId ?? "",
    r.sku,
    r.barcode ?? "",
    r.title,
    r.titleAr,
    r.category ?? "",
    r.price === null ? "" : String(r.price),
    r.descriptionEn,
    r.descriptionAr,
    r.imageExportName ?? "",
    r.rafeeqId ?? "",
  ].join("");
  const rev = [...parts].reverse().join("");
  return `${fnv1a(parts)}${fnv1a(rev)}`;
}

/** Deterministic package fingerprint from its (sorted) item fingerprints. */
export function packageFingerprint(mode: RafeeqFullSyncMode, itemFingerprints: readonly string[]): string {
  const joined = `${mode}${[...itemFingerprints].sort().join("")}`;
  const rev = [...joined].reverse().join("");
  return `${fnv1a(joined)}${fnv1a(rev)}`;
}

// ── file naming + package layout ──────────────────────────────────────────────

function utcDateStamp(now: Date): string {
  return now.toISOString().slice(0, 10); // YYYY-MM-DD
}

/** rafeeq-full-YYYY-MM-DD.zip / rafeeq-new-products-YYYY-MM-DD.zip */
export function fullSyncZipName(mode: RafeeqFullSyncMode, now: Date): string {
  return mode === "FULL" ? `rafeeq-full-${utcDateStamp(now)}.zip` : `rafeeq-new-products-${utcDateStamp(now)}.zip`;
}

/** The root-level spreadsheet name inside the ZIP. */
export function fullSyncXlsxName(mode: RafeeqFullSyncMode): string {
  return mode === "FULL" ? "rafeeq_catalog.xlsx" : "rafeeq_new_products.xlsx";
}

/** ZIP layout: /<xlsx> + /images/<file> + /manifest.json (root level). */
export function fullSyncImageEntryName(filename: string): string {
  return `images/${filename}`;
}
export const FULLSYNC_MANIFEST_NAME = "manifest.json";

// ── manifest ──────────────────────────────────────────────────────────────────

export interface FullSyncManifestInput {
  storefrontKey: string;
  mode: RafeeqFullSyncMode;
  generatedAt: string;
  actor: string | null;
  productRowCount: number;
  imageCount: number;
  mappedIdCount: number;      // rows shipped with a preserved resolved Rafeeq id
  newMarkerCount: number;     // rows shipped with the "new product" marker
  needsReviewIncluded: number;
  trueBlockersExcluded: number;
  outputFilename: string;
  xlsxFilename: string;
  packageFingerprint: string;
}

export function buildFullSyncManifest(input: FullSyncManifestInput): Record<string, unknown> {
  return {
    schema: "rafeeq-fullsync-manifest/1",
    destination: input.storefrontKey,
    mode: input.mode,
    generated_at: input.generatedAt,
    actor: input.actor,
    product_row_count: input.productRowCount,
    image_count: input.imageCount,
    mapped_id_count: input.mappedIdCount,
    new_marker_count: input.newMarkerCount,
    needs_review_included: input.needsReviewIncluded,
    true_blockers_excluded: input.trueBlockersExcluded,
    output_filename: input.outputFilename,
    xlsx_filename: input.xlsxFilename,
    package_fingerprint: input.packageFingerprint,
  };
}
