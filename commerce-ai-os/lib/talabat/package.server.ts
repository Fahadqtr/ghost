// INT.2B.2 — Talabat outbound package GENERATOR (SERVER-ONLY).
//
// Turns the certified INT.2B preview into the downloadable package:
//   Talabat/talabat-products.xlsx  +  Talabat/images/<SELLABLE_SKU>.<ext>  +  manifest.json
//
// It CONSUMES loadTalabatPreview() (the single bounded read + certified
// flattening/validation) — it never re-flattens, never re-derives SKU/barcode/
// title/image resolution/lifecycle/readiness, and never emits a parent row.
// Only NOT-BLOCKED rows are packaged; blocked rows are always excluded. It
// mutates NO business data: the sole write is a best-effort malak_audit trail
// row (the durable Export History source). Images are fetched through the
// certified SSRF-safe boundary (safeImageUrlOrNull + safeFetchImage) and their
// real content is verified before packaging. Deterministic order throughout; an
// XLSX↔ZIP integrity check runs before the archive is finalized.
//
// Lives OUTSIDE lib/export on purpose: the INT.2A foundation guard pins lib/export
// as read-only + generation-free. Generation (xlsx + zip + fetch + audit) lives
// here and is reached only through the writer-gated API route.

import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { insertAuditRow } from "@/lib/audit";
import { safeImageUrlOrNull, safeFetchImage } from "@/lib/net/safeImage";
import { buildZip, type ZipEntry } from "@/lib/net/zip";
import { buildTalabatXlsxBuffer } from "@/lib/talabat/package-xlsx";
import { loadTalabatPreview } from "@/lib/export/talabat/preview.server";
import {
  resolveGenerationSet,
  planRowImages,
  toPackageRow,
  usesSharedProductImage,
  checkReferentialIntegrity,
  buildManifest,
  sniffImageExtension,
  mimeToExt,
  primaryFilenameFor,
  TALABAT_PACKAGE_LIMITS,
  type TalabatGenerationMode,
  type TalabatPackageRow,
  type PackagedFile,
} from "@/lib/export/talabat/package";
import type { TalabatPreviewRow } from "@/lib/export/talabat/preview";

const DESTINATION = "talabat:malikas";
const IMAGE_FETCH_CONCURRENCY = 6;

export interface GeneratePackageOptions {
  mode: TalabatGenerationMode;
  selectedKeys?: readonly string[];
  actor: string | null;
  now?: Date;
}

export interface TalabatPackageSummary {
  destination: string;
  generatedAt: string;
  actor: string | null;
  outputFilename: string;
  sellableRowCount: number;
  simpleProductCount: number;
  variantRowCount: number;
  imageCount: number;
  warningCount: number;
  imageSharedFromProductCount: number;
  excludedBlockedCount: number;
  excludedNoImageCount: number;
  cappedExcludedCount: number;
  integrityOk: boolean;
}

export type GeneratePackageResult =
  | { ok: true; filename: string; bytes: Uint8Array; summary: TalabatPackageSummary }
  | { ok: false; error: GeneratePackageError };

export type GeneratePackageError =
  | "preview_unavailable"
  | "no_exportable_rows"
  | "integrity_failed"
  | "generation_failed";

interface ResolvedImage {
  bytes: Uint8Array;
  filename: string;
  kind: "primary" | "gallery";
  ownerPrimary?: string;
}

interface ResolvedRow {
  row: TalabatPreviewRow;
  primary: ResolvedImage;
  gallery: ResolvedImage[];
}

/** ISO timestamp compacted for a filename: 2026-08-17T09-30-00Z. */
function fileStamp(now: Date): string {
  return now.toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "-");
}

/** Fetch + validate ONE image; returns bytes + a canonical extension, or null. */
async function fetchValidatedImage(
  sourceUrl: string,
): Promise<{ bytes: Uint8Array; ext: string } | null> {
  const safe = safeImageUrlOrNull(sourceUrl);
  if (!safe) return null; // unsafe / internal / non-https → never fetched
  let res: Response;
  try {
    res = await safeFetchImage(safe);
  } catch {
    return null; // network / redirect-to-internal → skip
  }
  if (!res.ok) return null;
  let buf: ArrayBuffer;
  try {
    buf = await res.arrayBuffer();
  } catch {
    return null;
  }
  const bytes = new Uint8Array(buf);
  if (bytes.length === 0) return null; // empty file
  if (bytes.length > TALABAT_PACKAGE_LIMITS.maxImageBytes) return null; // oversized

  // "actual content is an image": trust the sniffed magic bytes first, then the
  // declared content-type. A file whose real bytes are not an image is dropped
  // even if its URL/extension/content-type claimed otherwise (§7).
  const sniffed = sniffImageExtension(bytes);
  const declared = mimeToExt(res.headers.get("content-type"));
  const ext = sniffed ?? declared;
  if (!ext) return null; // content is not a recognized image
  return { bytes, ext };
}

/** Run async tasks with a bounded concurrency pool, preserving input order. */
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

/**
 * Generate the Talabat outbound package. Caller MUST have already enforced the
 * writer authorization boundary (the API route does). Read-only against the
 * catalog; the only write is a best-effort audit row.
 */
export async function generateTalabatPackage(opts: GeneratePackageOptions): Promise<GeneratePackageResult> {
  const now = opts.now ?? new Date();
  const startedAt = now.toISOString();

  const preview = await loadTalabatPreview();
  if (!preview) return { ok: false, error: "preview_unavailable" };

  const set = resolveGenerationSet(preview.rows, { mode: opts.mode, selectedKeys: opts.selectedKeys });

  // Deterministic cap (never silent — the dropped count is reported, §24).
  const capped = set.included.slice(0, TALABAT_PACKAGE_LIMITS.maxRows);
  const cappedExcludedCount = set.included.length - capped.length;
  if (capped.length === 0) return { ok: false, error: "no_exportable_rows" };

  try {
    // Resolve every row's images (bounded concurrency; no per-image DB query).
    const resolvedRows = await mapPool(capped, IMAGE_FETCH_CONCURRENCY, async (row): Promise<ResolvedRow | null> => {
      const plan = planRowImages(row);
      if (!plan.primary) return null; // no retrievable primary URL → excluded

      const primaryFetch = await fetchValidatedImage(plan.primary.sourceUrl);
      if (!primaryFetch) return null; // primary unretrievable/invalid → excluded

      const primaryFilename = primaryFilenameFor(row, primaryFetch.ext);
      const primary: ResolvedImage = { bytes: primaryFetch.bytes, filename: primaryFilename, kind: "primary" };

      // Gallery images are best-effort: a failed extra is simply omitted and is
      // never referenced by the XLSX (which cites only the primary), so integrity
      // is preserved. Numbering follows the surviving order (_2, _3, …).
      const gallery: ResolvedImage[] = [];
      let position = 2;
      for (const g of plan.gallery) {
        const got = await fetchValidatedImage(g.sourceUrl);
        if (!got) continue;
        const name = primaryFilenameFor(row, got.ext).replace(/(\.[^.]+)$/, `_${position}$1`);
        gallery.push({ bytes: got.bytes, filename: name, kind: "gallery", ownerPrimary: primaryFilename });
        position++;
      }
      return { row, primary, gallery };
    });

    const survivors = resolvedRows.filter((r): r is ResolvedRow => r !== null);
    const excludedNoImageCount = capped.length - survivors.length;
    if (survivors.length === 0) return { ok: false, error: "no_exportable_rows" };

    // XLSX rows (deterministic order) — the FINAL primary filename per row.
    const packageRows: TalabatPackageRow[] = survivors.map((s) => toPackageRow(s.row, s.primary.filename));
    const xlsxImageRefs = packageRows.map((r) => r.imageFilename);

    // Full packaged-file inventory (primary + gallery) for the integrity check.
    const packaged: PackagedFile[] = [];
    for (const s of survivors) {
      packaged.push({ name: s.primary.filename, kind: "primary" });
      for (const g of s.gallery) packaged.push({ name: g.filename, kind: "gallery", ownerPrimary: g.ownerPrimary });
    }

    // Deterministic XLSX↔ZIP integrity BEFORE finalizing (§8). Never ship a
    // package whose sheet references a missing image or vice-versa.
    const integrity = checkReferentialIntegrity(xlsxImageRefs, packaged);
    if (!integrity.ok) return { ok: false, error: "integrity_failed" };

    const xlsxBytes = buildTalabatXlsxBuffer(packageRows);

    const variantRowCount = survivors.filter((s) => s.row.isVariant).length;
    const simpleProductCount = survivors.length - variantRowCount;
    const warningCount = survivors.filter((s) => s.row.status === "WARNING").length;
    const imageSharedFromProductCount = survivors.filter((s) => usesSharedProductImage(s.row)).length;
    const imageCount = packaged.length;
    const outputFilename = `talabat-export-${fileStamp(now)}.zip`;

    const manifest = buildManifest({
      destination: DESTINATION,
      generatedAt: startedAt,
      actor: opts.actor,
      simpleProductCount,
      variantRowCount,
      sellableRowCount: survivors.length,
      imageCount,
      warningCount,
      imageSharedFromProductCount,
      excludedBlockedCount: set.excludedBlocked.length,
      outputFilename,
      previewReference: {
        product_count: preview.counts.productCount,
        variant_count: preview.counts.variantCount,
        sellable_row_count: preview.counts.sellableRowCount,
        generated_at: startedAt,
      },
    });

    // Assemble the archive under a top-level Talabat/ folder (matches the spec
    // package tree). Deterministic order: sheet, images, manifest.
    const entries: ZipEntry[] = [{ name: "Talabat/talabat-products.xlsx", data: xlsxBytes }];
    for (const s of survivors) {
      entries.push({ name: `Talabat/images/${s.primary.filename}`, data: s.primary.bytes });
      for (const g of s.gallery) entries.push({ name: `Talabat/images/${g.filename}`, data: g.bytes });
    }
    entries.push({ name: "Talabat/manifest.json", data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)) });

    const bytes = buildZip(entries);

    const summary: TalabatPackageSummary = {
      destination: DESTINATION,
      generatedAt: startedAt,
      actor: opts.actor,
      outputFilename,
      sellableRowCount: survivors.length,
      simpleProductCount,
      variantRowCount,
      imageCount,
      warningCount,
      imageSharedFromProductCount,
      excludedBlockedCount: set.excludedBlocked.length,
      excludedNoImageCount,
      cappedExcludedCount,
      integrityOk: true,
    };

    await recordAudit(summary, "done", now);
    return { ok: true, filename: outputFilename, bytes, summary };
  } catch {
    // Never surface a raw error (table/column names, ids, URLs). Record the
    // failure to the audit trail (best-effort) and return a safe sentinel.
    await recordAudit(
      {
        destination: DESTINATION,
        generatedAt: startedAt,
        actor: opts.actor,
        outputFilename: "",
        sellableRowCount: 0,
        simpleProductCount: 0,
        variantRowCount: 0,
        imageCount: 0,
        warningCount: 0,
        imageSharedFromProductCount: 0,
        excludedBlockedCount: set.excludedBlocked.length,
        excludedNoImageCount: 0,
        cappedExcludedCount,
        integrityOk: false,
      },
      "error",
      new Date(),
    ).catch(() => {});
    return { ok: false, error: "generation_failed" };
  }
}

/**
 * Durable Export History (§16) via the EXISTING audit framework (malak_audit) —
 * no new table, no migration. Records destination, actor, timing, counts, the
 * output filename, and the excluded-blocked count. Best-effort: a failed audit
 * never fails the package.
 */
async function recordAudit(summary: TalabatPackageSummary, status: "done" | "error", finishedAt: Date): Promise<void> {
  try {
    const admin = createAdminClient() as never;
    await insertAuditRow(admin, {
      action_type: "talabat_package_export",
      agent: summary.actor ?? "unknown",
      product_id: null,
      field: "export_package",
      old_value: null,
      new_value: summary.outputFilename || null,
      details: {
        destination: summary.destination,
        actor: summary.actor,
        started_at: summary.generatedAt,
        finished_at: finishedAt.toISOString(),
        status,
        sellable_row_count: summary.sellableRowCount,
        variant_count: summary.variantRowCount,
        simple_product_count: summary.simpleProductCount,
        image_count: summary.imageCount,
        warning_count: summary.warningCount,
        image_shared_from_product_count: summary.imageSharedFromProductCount,
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
