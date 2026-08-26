// INT.2D — Rafeeq outbound package GENERATOR (SERVER-ONLY).
//
// Turns the certified Rafeeq preview into the downloadable package:
//   Rafeeq-Malikas/rafeeq-products.xlsx + Rafeeq-Malikas/images/<SKU>.<ext> + manifest.json
//
// It CONSUMES loadRafeeqPreview() — the single bounded read + ECL-scoped identity
// (rafeeq:malikas) + validation — and never re-derives identity, never reads the
// legacy per-store id column, never auto-resolves a needs_review conflict (those
// rows are already BLOCKED in the preview), and never fabricates an id. Only
// NOT-blocked rows are packaged. It mutates NO business data (no catalog/
// inventory/availability/ECL writes, no Rafeeq API publish): the sole write is a
// best-effort malak_audit trail row. Images use the certified SSRF-safe boundary
// and are verified before packaging. A post-sanitization filename collision
// aborts generation (§15). Lives OUTSIDE lib/export (read-only + generation-free).

import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { insertAuditRow } from "@/lib/audit";
import { safeImageUrlOrNull, safeFetchImage } from "@/lib/net/safeImage";
import { buildZip, type ZipEntry } from "@/lib/net/zip";
import { buildRafeeqXlsxBuffer } from "@/lib/rafeeq/package-xlsx";
import { loadRafeeqPreview } from "@/lib/export/rafeeq/preview.server";
import type { RafeeqPreviewRow } from "@/lib/export/rafeeq/preview";
import {
  resolveRafeeqGenerationSet,
  planRowImages,
  toPackageRow,
  checkReferentialIntegrity,
  buildManifest,
  primaryFilenameFor,
  detectFilenameCollisions,
  RAFEEQ_NEW_MARKER,
  PACKAGE_LIMITS,
  type RafeeqGenerationMode,
  type RafeeqPackageRow,
  type PackagedFile,
} from "@/lib/export/rafeeq/package";
import { sniffImageExtension, mimeToExt } from "@/lib/export/package-core";
import { physicalRowCount as countPhysicalRows } from "@/lib/export/rafeeq/package";
import { buildMalikasReferenceAoa } from "@/lib/export/rafeeq/reference";
import { buildOptionsOverviewSheet } from "@/lib/export/rafeeq/options-overview";
import {
  resolveFullSyncSet,
  applyFullSyncRafeeqId,
  deliveryKeyOfRow,
  rowFingerprint,
  packageFingerprint,
  fullSyncZipName,
  fullSyncXlsxName,
  fullSyncImageEntryName,
  buildFullSyncManifest,
  FULLSYNC_MANIFEST_NAME,
  type RafeeqFullSyncMode,
} from "@/lib/export/rafeeq/fullsync";

const IMAGE_FETCH_CONCURRENCY = 6;
const FOLDER = "Rafeeq-Malikas";

export interface GeneratePackageOptions {
  mode: RafeeqGenerationMode;
  selectedKeys?: readonly string[];
  actor: string | null;
  now?: Date;
}

export interface RafeeqPackageSummary {
  mode: RafeeqGenerationMode;
  generatedAt: string;
  actor: string | null;
  outputFilename: string;
  productRowCount: number;
  mappedCount: number;
  unmappedCount: number;
  needsReviewExcluded: number;
  imageCount: number;
  warningCount: number;
  excludedBlockedCount: number;
  excludedNoImageCount: number;
  cappedExcludedCount: number;
  integrityOk: boolean;
}

export type GeneratePackageResult =
  | { ok: true; filename: string; bytes: Uint8Array; summary: RafeeqPackageSummary }
  | { ok: false; error: GeneratePackageError };

export type GeneratePackageError = "preview_unavailable" | "no_exportable_rows" | "filename_collision" | "integrity_failed" | "generation_failed";

interface ResolvedImage { bytes: Uint8Array; filename: string; kind: "primary" }
interface ResolvedRow { row: RafeeqPreviewRow; primary: ResolvedImage }

function fileStamp(now: Date): string {
  return now.toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "-");
}

async function fetchValidatedImage(sourceUrl: string): Promise<{ bytes: Uint8Array; ext: string } | null> {
  const safe = safeImageUrlOrNull(sourceUrl);
  if (!safe) return null;
  let res: Response;
  try { res = await safeFetchImage(safe); } catch { return null; }
  if (!res.ok) return null;
  let buf: ArrayBuffer;
  try { buf = await res.arrayBuffer(); } catch { return null; }
  const bytes = new Uint8Array(buf);
  if (bytes.length === 0 || bytes.length > PACKAGE_LIMITS.maxImageBytes) return null;
  const ext = sniffImageExtension(bytes) ?? mimeToExt(res.headers.get("content-type"));
  if (!ext) return null;
  return { bytes, ext };
}

async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Shared image-resolution core (OWNER CONTRACT: PRIMARY ONLY): fetch +
 *  validate each row's canonical PRIMARY image through the certified SSRF-safe
 *  boundary — bytes preserved exactly as downloaded, gallery/variant images
 *  never fetched. A row without a valid primary drops out. */
async function resolveRowImages(rows: readonly RafeeqPreviewRow[]): Promise<ResolvedRow[]> {
  const resolvedRows = await mapPool(rows, IMAGE_FETCH_CONCURRENCY, async (row): Promise<ResolvedRow | null> => {
    const plan = planRowImages(row);
    if (!plan.primary) return null;
    const primaryFetch = await fetchValidatedImage(plan.primary.sourceUrl);
    if (!primaryFetch) return null;
    const primaryFilename = primaryFilenameFor(row.sku, primaryFetch.ext);
    return { row, primary: { bytes: primaryFetch.bytes, filename: primaryFilename, kind: "primary" } };
  });
  return resolvedRows.filter((r): r is ResolvedRow => r !== null);
}

/**
 * Generate the Rafeeq package. Caller MUST have enforced the writer boundary.
 * Read-only against the catalog; the only write is a best-effort audit row.
 */
export async function generateRafeeqPackage(opts: GeneratePackageOptions): Promise<GeneratePackageResult> {
  const now = opts.now ?? new Date();
  const startedAt = now.toISOString();

  const preview = await loadRafeeqPreview();
  if (!preview) return { ok: false, error: "preview_unavailable" };

  const set = resolveRafeeqGenerationSet(preview.rows, { mode: opts.mode, selectedKeys: opts.selectedKeys });
  const capped = set.included.slice(0, PACKAGE_LIMITS.maxRows);
  const cappedExcludedCount = set.included.length - capped.length;
  if (capped.length === 0) return { ok: false, error: "no_exportable_rows" };

  try {
    const survivors = await resolveRowImages(capped);
    const excludedNoImageCount = capped.length - survivors.length;
    if (survivors.length === 0) return { ok: false, error: "no_exportable_rows" };

    // §15 — a post-sanitization primary filename collision aborts generation.
    const collisions = detectFilenameCollisions(survivors.map((s) => s.primary.filename));
    if (collisions.length > 0) return { ok: false, error: "filename_collision" };

    const packageRows: RafeeqPackageRow[] = survivors.map((s) => toPackageRow(s.row, s.primary.filename));
    const rowImageRefs = packageRows.map((r) => r.imageName);

    const packaged: PackagedFile[] = survivors.map((s) => ({ name: s.primary.filename, kind: "primary" as const }));

    const integrity = checkReferentialIntegrity(rowImageRefs, packaged);
    if (!integrity.ok) return { ok: false, error: "integrity_failed" };

    // Two-sheet workbook: the audited "data" import sheet + the human
    // "Malikas Reference" sheet (explanatory only, never the import contract).
    const referenceAoa = buildMalikasReferenceAoa(survivors.map((s, i) => ({
      row: s.row,
      imageFilename: s.primary.filename,
      productIdCell: packageRows[i].rafeeqId,
    })));
    const optionsOverview = buildOptionsOverviewSheet(survivors.map((s) => ({ row: s.row, imageFilename: s.primary.filename })));
    const xlsxBytes = buildRafeeqXlsxBuffer(packageRows, referenceAoa, optionsOverview);

    const mappedCount = survivors.filter((s) => s.row.rafeeqId !== null).length;
    const unmappedCount = survivors.length - mappedCount;
    const warningCount = survivors.filter((s) => s.row.status === "WARNING").length;
    const imageCount = packaged.length;
    const outputFilename = `rafeeq-malikas-export-${fileStamp(now)}.zip`;

    const manifest = buildManifest({
      storefrontKey: "rafeeq:malikas",
      mode: opts.mode,
      generatedAt: startedAt,
      actor: opts.actor,
      productRowCount: survivors.length,
      mappedCount,
      unmappedCount,
      needsReviewExcluded: preview.counts.needsReviewCount,
      imageCount,
      warningCount,
      excludedBlockedCount: set.excludedBlocked.length,
      outputFilename,
      previewReference: {
        product_count: preview.counts.productCount,
        mapped_count: preview.counts.mappedCount,
        unmapped_count: preview.counts.unmappedCount,
        needs_review_count: preview.counts.needsReviewCount,
        generated_at: startedAt,
      },
    });

    const entries: ZipEntry[] = [{ name: `${FOLDER}/rafeeq-products.xlsx`, data: xlsxBytes }];
    for (const s of survivors) entries.push({ name: `${FOLDER}/images/${s.primary.filename}`, data: s.primary.bytes });
    entries.push({ name: `${FOLDER}/manifest.json`, data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)) });

    const bytes = buildZip(entries);

    const summary: RafeeqPackageSummary = {
      mode: opts.mode, generatedAt: startedAt, actor: opts.actor, outputFilename,
      productRowCount: survivors.length, mappedCount, unmappedCount, needsReviewExcluded: preview.counts.needsReviewCount,
      imageCount, warningCount, excludedBlockedCount: set.excludedBlocked.length, excludedNoImageCount, cappedExcludedCount, integrityOk: true,
    };

    await recordAudit(summary, "done", now);
    return { ok: true, filename: outputFilename, bytes, summary };
  } catch {
    await recordAudit(
      {
        mode: opts.mode, generatedAt: startedAt, actor: opts.actor, outputFilename: "",
        productRowCount: 0, mappedCount: 0, unmappedCount: 0, needsReviewExcluded: preview.counts.needsReviewCount,
        imageCount: 0, warningCount: 0, excludedBlockedCount: set.excludedBlocked.length, excludedNoImageCount: 0, cappedExcludedCount, integrityOk: false,
      },
      "error",
      new Date(),
    ).catch(() => {});
    return { ok: false, error: "generation_failed" };
  }
}

/** Durable Export History via the existing malak_audit framework — no new schema. */
async function recordAudit(summary: RafeeqPackageSummary, status: "done" | "error", finishedAt: Date): Promise<void> {
  try {
    const admin = createAdminClient() as never;
    await insertAuditRow(admin, {
      action_type: "rafeeq_package_export",
      agent: summary.actor ?? "unknown",
      product_id: null,
      field: "export_package",
      old_value: null,
      new_value: summary.outputFilename || null,
      details: {
        destination: "rafeeq:malikas",
        actor: summary.actor,
        mode: summary.mode,
        started_at: summary.generatedAt,
        finished_at: finishedAt.toISOString(),
        status,
        product_row_count: summary.productRowCount,
        mapped_count: summary.mappedCount,
        unmapped_count: summary.unmappedCount,
        needs_review_excluded: summary.needsReviewExcluded,
        image_count: summary.imageCount,
        warning_count: summary.warningCount,
        error_count: status === "error" ? 1 : 0,
        output_filename: summary.outputFilename,
        excluded_blocked_count: summary.excludedBlockedCount,
        excluded_no_image_count: summary.excludedNoImageCount,
      },
      status,
    });
  } catch {
    /* best-effort audit — never block the package */
  }
}

// ── RAFEEQ FULLSYNC — canonical FULL / NEW file-sync packages ─────────────────
//
// Same certified pipeline (preview → image boundary → collision → integrity →
// xlsx → zip) on the AUDITED native template, different SELECTION + LAYOUT:
//   • FULL: every FULL-includable PRODUCT (a product blocked ONLY by the
//     identity review ships with a BLANK product_id — contested ids never used);
//   • NEW:  the pending products — kind NEW ships with a blank product_id,
//     kind OPTION_UPDATE preserves its resolved id so Rafeeq updates the
//     existing product (a new option is never a separate new product);
//   • layout: /<rafeeq_catalog|rafeeq_new_products>.xlsx + /images/ +
//     /manifest.json at the ZIP ROOT (rafeeq-full-YYYY-MM-DD.zip naming).
//     Images ship ONCE per product (parent-SKU filenames) — never per option.
// Recording the durable package row is the ROUTE's job (lib/rafeeq/
// fullsync.server) — this generator stays write-free (audit floor only).

export interface FullSyncGenerateOptions {
  mode: RafeeqFullSyncMode;
  /** SENT baseline at PRODUCT grain: product id → last-sent delivery fingerprint. */
  sentBaseline: ReadonlyMap<string, string | null>;
  actor: string | null;
  now?: Date;
}

export interface FullSyncItemOut {
  productId: string;
  /** always null — delivery identity is the parent product (options inside). */
  variantId: null;
  sku: string;
  fingerprint: string;
  rafeeqIdSent: string;
}

export interface FullSyncPackageSummary {
  mode: RafeeqFullSyncMode;
  generatedAt: string;
  actor: string | null;
  outputFilename: string;
  xlsxFilename: string;
  /** canonical Rafeeq PRODUCT identities in the file. */
  productRowCount: number;
  /** physical spreadsheet data rows (parents repeated once per option). */
  physicalRowCount: number;
  productsWithOptions: number;
  optionCount: number;
  optionUpdateCount: number;
  mappedIdCount: number;
  newMarkerCount: number;
  needsReviewIncluded: number;
  trueBlockersExcluded: number;
  alreadySentExcluded: number;
  excludedNoImageCount: number;
  cappedExcludedCount: number;
  imageCount: number;
  manifestFingerprint: string;
  integrityOk: boolean;
}

export type GenerateFullSyncResult =
  | { ok: true; filename: string; bytes: Uint8Array; summary: FullSyncPackageSummary; items: FullSyncItemOut[] }
  | { ok: false; error: GeneratePackageError };

/**
 * Generate the FULL-catalog or NEW-products Rafeeq package. Caller MUST have
 * enforced the writer boundary and supplied the durable sent baseline. Reads
 * the certified preview only; the sole write is the best-effort audit row.
 */
export async function generateRafeeqFullSyncPackage(opts: FullSyncGenerateOptions): Promise<GenerateFullSyncResult> {
  const now = opts.now ?? new Date();
  const startedAt = now.toISOString();

  const preview = await loadRafeeqPreview();
  if (!preview) return { ok: false, error: "preview_unavailable" };

  const set = resolveFullSyncSet(preview.rows, opts.mode, opts.sentBaseline);
  const capped = set.included.slice(0, PACKAGE_LIMITS.maxRows);
  const cappedExcludedCount = set.included.length - capped.length;
  if (capped.length === 0) return { ok: false, error: "no_exportable_rows" };

  try {
    const survivors = await resolveRowImages(capped);
    const excludedNoImageCount = capped.length - survivors.length;
    if (survivors.length === 0) return { ok: false, error: "no_exportable_rows" };

    // §15 — a post-sanitization primary filename collision aborts generation.
    const collisions = detectFilenameCollisions(survivors.map((sv) => sv.primary.filename));
    if (collisions.length > 0) return { ok: false, error: "filename_collision" };

    // product_id projection: FULL preserves resolved ids (blank for new); NEW
    // emits blank for NEW-kind products and preserves the resolved id for an
    // OPTION_UPDATE. Contested ids are already null in the preview. One image
    // set per PRODUCT — every repeated option row references the same file.
    const packageRows: RafeeqPackageRow[] = survivors.map((sv) =>
      applyFullSyncRafeeqId(
        toPackageRow(sv.row, sv.primary.filename),
        sv.row,
        opts.mode,
        set.includedKinds.get(deliveryKeyOfRow(sv.row)),
      ),
    );
    const rowImageRefs = packageRows.map((r) => r.imageName);

    const packaged: PackagedFile[] = survivors.map((sv) => ({ name: sv.primary.filename, kind: "primary" as const }));

    const integrity = checkReferentialIntegrity(rowImageRefs, packaged);
    if (!integrity.ok) return { ok: false, error: "integrity_failed" };

    // Two-sheet workbook: the audited "data" import sheet + the human
    // "Malikas Reference" sheet (NEW/EXISTING/OPTION UPDATE/CATEGORY REVIEW
    // notes derive from the same pending kinds that drive the product_id cell).
    const referenceAoa = buildMalikasReferenceAoa(survivors.map((sv, i) => ({
      row: sv.row,
      imageFilename: sv.primary.filename,
      productIdCell: packageRows[i].rafeeqId,
      kind: set.includedKinds.get(deliveryKeyOfRow(sv.row)),
    })));
    const optionsOverview = buildOptionsOverviewSheet(survivors.map((sv) => ({ row: sv.row, imageFilename: sv.primary.filename })));
    const xlsxBytes = buildRafeeqXlsxBuffer(packageRows, referenceAoa, optionsOverview);

    // Durable item snapshot at PRODUCT grain — one record per Rafeeq product
    // identity, carrying the delivery fingerprint (full option set included).
    const items: FullSyncItemOut[] = survivors.map((sv, i) => ({
      productId: sv.row.internalProductId,
      variantId: null,
      sku: sv.row.sku,
      fingerprint: rowFingerprint(sv.row),
      rafeeqIdSent: packageRows[i].rafeeqId || RAFEEQ_NEW_MARKER,
    }));
    const manifestFingerprint = packageFingerprint(opts.mode, items.map((it) => it.fingerprint));

    const newMarkerCount = packageRows.filter((r) => r.rafeeqId === "").length;
    const mappedIdCount = packageRows.length - newMarkerCount;
    const needsReviewIncluded = survivors.filter((sv) => sv.row.needsOwnerReview).length;
    const imageCount = packaged.length;
    const physicalRows = countPhysicalRows(packageRows);
    const productsWithOptions = survivors.filter((sv) => sv.row.hasOptions).length;
    const optionCount = survivors.reduce((acc, sv) => acc + sv.row.optionCount, 0);
    const outputFilename = fullSyncZipName(opts.mode, now);
    const xlsxFilename = fullSyncXlsxName(opts.mode);

    const manifest = buildFullSyncManifest({
      storefrontKey: "rafeeq:malikas",
      mode: opts.mode,
      generatedAt: startedAt,
      actor: opts.actor,
      productRowCount: packageRows.length,
      physicalRowCount: physicalRows,
      productsWithOptions,
      optionCount,
      optionUpdateCount: set.counts.optionUpdates,
      imageCount,
      mappedIdCount,
      newMarkerCount,
      needsReviewIncluded,
      trueBlockersExcluded: set.counts.trueBlockers,
      outputFilename,
      xlsxFilename,
      packageFingerprint: manifestFingerprint,
    });

    // ZIP layout at the ROOT: /<xlsx> + /images/<file> + /manifest.json.
    const entries: ZipEntry[] = [{ name: xlsxFilename, data: xlsxBytes }];
    for (const sv of survivors) entries.push({ name: fullSyncImageEntryName(sv.primary.filename), data: sv.primary.bytes });
    entries.push({ name: FULLSYNC_MANIFEST_NAME, data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)) });

    const bytes = buildZip(entries);

    const summary: FullSyncPackageSummary = {
      mode: opts.mode,
      generatedAt: startedAt,
      actor: opts.actor,
      outputFilename,
      xlsxFilename,
      productRowCount: packageRows.length,
      physicalRowCount: physicalRows,
      productsWithOptions,
      optionCount,
      optionUpdateCount: set.counts.optionUpdates,
      mappedIdCount,
      newMarkerCount,
      needsReviewIncluded,
      trueBlockersExcluded: set.counts.trueBlockers,
      alreadySentExcluded: set.excludedAlreadySent.length,
      excludedNoImageCount,
      cappedExcludedCount,
      imageCount,
      manifestFingerprint,
      integrityOk: true,
    };

    await recordFullSyncAudit(summary, "done", new Date());
    return { ok: true, filename: outputFilename, bytes, summary, items };
  } catch {
    await recordFullSyncAudit(
      {
        mode: opts.mode, generatedAt: startedAt, actor: opts.actor, outputFilename: "", xlsxFilename: fullSyncXlsxName(opts.mode),
        productRowCount: 0, physicalRowCount: 0, productsWithOptions: 0, optionCount: 0, optionUpdateCount: 0,
        mappedIdCount: 0, newMarkerCount: 0, needsReviewIncluded: 0,
        trueBlockersExcluded: set.counts.trueBlockers, alreadySentExcluded: set.excludedAlreadySent.length,
        excludedNoImageCount: 0, cappedExcludedCount, imageCount: 0, manifestFingerprint: "", integrityOk: false,
      },
      "error",
      new Date(),
    ).catch(() => {});
    return { ok: false, error: "generation_failed" };
  }
}

/** Audit floor for a FULL/NEW generation via the shared helper (never a direct write). */
async function recordFullSyncAudit(summary: FullSyncPackageSummary, status: "done" | "error", finishedAt: Date): Promise<void> {
  try {
    const admin = createAdminClient() as never;
    await insertAuditRow(admin, {
      action_type: "rafeeq_fullsync_package_export",
      agent: summary.actor ?? "unknown",
      product_id: null,
      field: "export_package",
      old_value: null,
      new_value: summary.outputFilename || null,
      details: {
        destination: "rafeeq:malikas",
        actor: summary.actor,
        mode: summary.mode,
        started_at: summary.generatedAt,
        finished_at: finishedAt.toISOString(),
        status,
        product_identity_count: summary.productRowCount,
        physical_row_count: summary.physicalRowCount,
        products_with_options: summary.productsWithOptions,
        option_count: summary.optionCount,
        option_update_count: summary.optionUpdateCount,
        mapped_id_count: summary.mappedIdCount,
        new_marker_count: summary.newMarkerCount,
        needs_review_included: summary.needsReviewIncluded,
        true_blockers_excluded: summary.trueBlockersExcluded,
        already_sent_excluded: summary.alreadySentExcluded,
        image_count: summary.imageCount,
        manifest_fingerprint: summary.manifestFingerprint,
        output_filename: summary.outputFilename,
      },
      status,
    });
  } catch {
    /* best-effort audit — never block the package */
  }
}
