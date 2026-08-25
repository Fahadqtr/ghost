// RAFEEQ FULLSYNC — canonical catalog → Rafeeq file-sync PLAN (PURE).
//
// The main catalog is the single source of truth for Rafeeq. Delivery identity
// is the RAFEEQ PARENT PRODUCT (native-option model — variants are OPTIONS of
// one product, never separate Rafeeq products):
//
//   • FULL — every currently exportable canonical product. A product whose ONLY
//     blocker is the contested-identity review (IDENTITY_NEEDS_REVIEW) is
//     INCLUDED with a BLANK product_id (its contested id is never surfaced,
//     never guessed) — every true blocker still excludes.
//   • NEW  — the PENDING products only:
//       – kind NEW           → exportable and never contained in a SENT package;
//       – kind OPTION_UPDATE → contained in a SENT package whose recorded
//         delivery fingerprint no longer matches the product's current
//         fingerprint (an option added/removed/renamed/repriced, or any parent
//         content change). The parent product re-queues as an UPDATE — a new
//         option is NEVER pretended to be a separate new Rafeeq product.
//     Identity does NOT define newness; products.created_at is NEVER consulted.
//
// The delivery fingerprint incorporates the FULL ordered option set (and
// excludes the mapping id — resolving an identity is not a content change), so
// option-set changes are detected deterministically. Sent state is durable +
// explicit: only a package row with sent_at != null counts; generating or
// downloading NEVER changes the pending queue.
//
// Legacy tolerance: items recorded by the retired variant-grain model
// (variant_id != null) mark their parent product as sent at an UNKNOWN
// fingerprint — the product surfaces as OPTION_UPDATE pending (a safe
// re-baseline), never silently treated as current. No I/O.

import { type RafeeqPackageRow } from "./package.ts";
import { productRowKey, type RafeeqPreviewRow } from "./preview.ts";

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

/** A durable package item (normalized from rafeeq_package_items). Product-grain
 *  going forward; legacy variant-grain rows keep their variant_id. */
export interface RafeeqPackageItemRecord {
  packageId: string;
  productId: string;
  /** null for a product-grain record; set on retired variant-grain records. */
  variantId: string | null;
  sku: string;
  /** the recorded delivery fingerprint (null on legacy/unknown records). */
  fingerprint?: string | null;
}

/** The durable delivery identity of a preview row — the parent product. */
export function deliveryKeyOfRow(r: Pick<RafeeqPreviewRow, "internalProductId">): string {
  return productRowKey(r.internalProductId);
}

/**
 * The SENT baseline at PRODUCT grain: product id → the delivery fingerprint it
 * was last sent with. Only packages the owner explicitly marked SENT
 * contribute. A product-grain item carries its recorded fingerprint; a legacy
 * variant-grain item (or a record without a fingerprint) yields NULL — sent at
 * an UNKNOWN fingerprint, which always reads as changed (safe re-baseline).
 */
export function sentProductBaseline(
  packages: readonly RafeeqPackageRecord[],
  items: readonly RafeeqPackageItemRecord[],
): Map<string, string | null> {
  const sentPackageIds = new Set<string>();
  for (const p of packages) if (p.sentAt !== null) sentPackageIds.add(p.id);
  const out = new Map<string, string | null>();
  for (const it of items) {
    if (!sentPackageIds.has(it.packageId)) continue;
    const fp = it.variantId === null ? (it.fingerprint ?? null) : null;
    const existing = out.get(it.productId);
    // Any unknown-fingerprint evidence for the product degrades it to NULL.
    if (existing === undefined) out.set(it.productId, fp);
    else if (existing !== fp) out.set(it.productId, null);
  }
  return out;
}

/** True once any package has been explicitly marked sent (the baseline exists). */
export function hasSentBaseline(packages: readonly RafeeqPackageRecord[]): boolean {
  return packages.some((p) => p.sentAt !== null);
}

// ── FULL eligibility ──────────────────────────────────────────────────────────

/**
 * Whether a canonical product enters the FULL catalog file. READY/WARNING
 * products always do. A BLOCKED product is included ONLY when every one of its
 * blocking reasons is IDENTITY_NEEDS_REVIEW — the contested identity does not
 * block the FULL file (the product ships with a blank product_id; the contested
 * id is never used). Any other blocker (missing/duplicate SKU, missing
 * image/title, stopped lifecycle, unresolved option pricing, cross-product
 * identity conflict, filename collision) keeps the product out.
 */
export function isFullIncludable(r: Pick<RafeeqPreviewRow, "status" | "reasons">): boolean {
  if (r.status === "READY" || r.status === "WARNING") return true;
  if (r.status !== "BLOCKED") return false;
  const blocking = r.reasons.filter((x) => x.blocking);
  return blocking.length > 0 && blocking.every((x) => x.code === "IDENTITY_NEEDS_REVIEW");
}

/** A FULL-includable product whose only blocker is the identity review. */
export function isNeedsReviewIncluded(r: Pick<RafeeqPreviewRow, "status" | "reasons">): boolean {
  return r.status === "BLOCKED" && isFullIncludable(r);
}

// ── pending derivation (NEW / OPTION_UPDATE) ──────────────────────────────────

export type RafeeqPendingKind = "NEW" | "OPTION_UPDATE";

export interface RafeeqPendingRow {
  row: RafeeqPreviewRow;
  kind: RafeeqPendingKind;
}

/**
 * Pending kind of one product against the SENT baseline:
 *   • not in the baseline                         → NEW;
 *   • in the baseline, fingerprint matches        → not pending (null);
 *   • in the baseline, fingerprint unknown/differs → OPTION_UPDATE.
 */
export function pendingKindOf(
  r: RafeeqPreviewRow,
  baseline: ReadonlyMap<string, string | null>,
): RafeeqPendingKind | null {
  if (!baseline.has(deliveryKeyOfRow(r))) return "NEW";
  const sentFp = baseline.get(deliveryKeyOfRow(r)) ?? null;
  return sentFp !== null && sentFp === rowFingerprint(r) ? null : "OPTION_UPDATE";
}

/**
 * PENDING = currently exportable (FULL-includable) AND (never sent, or sent
 * with a different/unknown delivery fingerprint). Derived only — never stored,
 * never ECL-based, never created_at-based.
 */
export function pendingRows(
  rows: readonly RafeeqPreviewRow[],
  baseline: ReadonlyMap<string, string | null>,
): RafeeqPendingRow[] {
  const out: RafeeqPendingRow[] = [];
  for (const r of rows) {
    if (!isFullIncludable(r)) continue;
    const kind = pendingKindOf(r, baseline);
    if (kind) out.push({ row: r, kind });
  }
  return out;
}

// ── generation set ────────────────────────────────────────────────────────────

export interface FullSyncGenerationSet {
  included: RafeeqPreviewRow[];
  /** pending kind per included product (NEW mode; FULL ⇒ undefined). */
  includedKinds: Map<string, RafeeqPendingKind>;
  /** products kept out by a TRUE blocker (never by the identity review alone). */
  excludedBlocked: RafeeqPreviewRow[];
  /** NEW mode only: includable products whose sent fingerprint is current. */
  excludedAlreadySent: RafeeqPreviewRow[];
  counts: {
    total: number;
    includable: number;
    trueBlockers: number;
    needsReviewIncluded: number;
    includedRows: number;
    optionUpdates: number;
  };
}

/** Resolve which products enter a FULL or NEW package. */
export function resolveFullSyncSet(
  rows: readonly RafeeqPreviewRow[],
  mode: RafeeqFullSyncMode,
  baseline: ReadonlyMap<string, string | null>,
): FullSyncGenerationSet {
  const included: RafeeqPreviewRow[] = [];
  const includedKinds = new Map<string, RafeeqPendingKind>();
  const excludedBlocked: RafeeqPreviewRow[] = [];
  const excludedAlreadySent: RafeeqPreviewRow[] = [];
  let includable = 0;
  let needsReviewIncluded = 0;
  let optionUpdates = 0;

  for (const r of rows) {
    if (!isFullIncludable(r)) {
      if (r.status === "BLOCKED") excludedBlocked.push(r);
      continue;
    }
    includable++;
    if (isNeedsReviewIncluded(r)) needsReviewIncluded++;
    if (mode === "NEW") {
      const kind = pendingKindOf(r, baseline);
      if (!kind) {
        excludedAlreadySent.push(r);
        continue;
      }
      includedKinds.set(deliveryKeyOfRow(r), kind);
      if (kind === "OPTION_UPDATE") optionUpdates++;
    }
    included.push(r);
  }

  return {
    included,
    includedKinds,
    excludedBlocked,
    excludedAlreadySent,
    counts: {
      total: rows.length,
      includable,
      trueBlockers: excludedBlocked.length,
      needsReviewIncluded,
      includedRows: included.length,
      optionUpdates,
    },
  };
}

// ── product_id projection per mode ────────────────────────────────────────────

/**
 * The product_id cell for a product in a file-sync package. Ids are NEVER
 * invented: a new record is BLANK. FULL preserves a valid resolved id; NEW
 * emits blank for a NEW-kind product and preserves the resolved id for an
 * OPTION_UPDATE (so Rafeeq updates the existing product instead of duplicating
 * it). A contested id is never emitted (needs_review ⇒ rafeeqId null already).
 */
export function fullSyncProductIdCell(
  row: Pick<RafeeqPreviewRow, "rafeeqId">,
  mode: RafeeqFullSyncMode,
  kind?: RafeeqPendingKind,
): string {
  if (mode === "NEW" && kind !== "OPTION_UPDATE") return "";
  return row.rafeeqId ?? "";
}

/** Apply the mode's product_id projection to an already-built package row. */
export function applyFullSyncRafeeqId(
  packageRow: RafeeqPackageRow,
  row: Pick<RafeeqPreviewRow, "rafeeqId">,
  mode: RafeeqFullSyncMode,
  kind?: RafeeqPendingKind,
): RafeeqPackageRow {
  return { ...packageRow, rafeeqId: fullSyncProductIdCell(row, mode, kind) };
}

// ── canonical delivery fingerprint (deterministic, dependency-free) ───────────

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
 * Deterministic PRODUCT delivery fingerprint over the canonical content the
 * Rafeeq file carries — parent fields PLUS the full ordered option set — so an
 * option added/removed/renamed/repriced changes the fingerprint and re-queues
 * the parent as OPTION_UPDATE. The mapping id is deliberately EXCLUDED
 * (resolving an identity is not a content change). Two passes (forward +
 * reversed) so accidental transpositions collide far less.
 */
export function rowFingerprint(r: RafeeqPreviewRow): string {
  const parts = [
    r.sku,
    r.barcode ?? "",
    r.title,
    r.titleAr,
    r.category ?? "",
    r.price === null ? "" : String(r.price),
    r.descriptionEn,
    r.descriptionAr,
    r.imageExportName ?? "",
    r.groupNameEn,
    r.groupNameAr,
    ...r.options.map((o) =>
      `${o.variantId ?? ""}|${o.internalSku ?? ""}|${o.nameEn}|${o.nameAr}|${o.effectivePrice ?? ""}|${o.sortOrder}`),
  ].join("");
  const rev = [...parts].reverse().join("");
  return `${fnv1a(parts)}${fnv1a(rev)}`;
}

/** Deterministic package fingerprint from its (sorted) item fingerprints. */
export function packageFingerprint(mode: RafeeqFullSyncMode, itemFingerprints: readonly string[]): string {
  const joined = `${mode}${[...itemFingerprints].sort().join("")}`;
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

export function fullSyncXlsxName(mode: RafeeqFullSyncMode): string {
  return mode === "FULL" ? "rafeeq_catalog.xlsx" : "rafeeq_new_products.xlsx";
}

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
  /** canonical Rafeeq PRODUCT identities in the file (never physical rows). */
  productRowCount: number;
  /** physical spreadsheet data rows (parents repeated once per option). */
  physicalRowCount: number;
  productsWithOptions: number;
  optionCount: number;
  optionUpdateCount: number;
  imageCount: number;
  mappedIdCount: number;
  newMarkerCount: number;
  needsReviewIncluded: number;
  trueBlockersExcluded: number;
  outputFilename: string;
  xlsxFilename: string;
  packageFingerprint: string;
}

export function buildFullSyncManifest(input: FullSyncManifestInput): Record<string, unknown> {
  return {
    schema: "rafeeq-fullsync-manifest/2",
    destination: input.storefrontKey,
    mode: input.mode,
    generated_at: input.generatedAt,
    actor: input.actor,
    product_identity_count: input.productRowCount,
    physical_row_count: input.physicalRowCount,
    products_with_options: input.productsWithOptions,
    option_count: input.optionCount,
    option_update_count: input.optionUpdateCount,
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
