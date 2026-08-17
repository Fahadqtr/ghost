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
  PACKAGE_LIMITS,
  type RafeeqGenerationMode,
  type RafeeqPackageRow,
  type PackagedFile,
} from "@/lib/export/rafeeq/package";
import { sniffImageExtension, mimeToExt } from "@/lib/export/package-core";

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

interface ResolvedImage { bytes: Uint8Array; filename: string; kind: "primary" | "gallery"; ownerPrimary?: string }
interface ResolvedRow { row: RafeeqPreviewRow; primary: ResolvedImage; gallery: ResolvedImage[] }

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
    const resolvedRows = await mapPool(capped, IMAGE_FETCH_CONCURRENCY, async (row): Promise<ResolvedRow | null> => {
      const plan = planRowImages(row);
      if (!plan.primary) return null;
      const primaryFetch = await fetchValidatedImage(plan.primary.sourceUrl);
      if (!primaryFetch) return null;
      const primaryFilename = primaryFilenameFor(row.sku, primaryFetch.ext);
      const primary: ResolvedImage = { bytes: primaryFetch.bytes, filename: primaryFilename, kind: "primary" };
      const gallery: ResolvedImage[] = [];
      let position = 2;
      for (const g of plan.gallery) {
        const got = await fetchValidatedImage(g.sourceUrl);
        if (!got) continue;
        const name = primaryFilenameFor(row.sku, got.ext).replace(/(\.[^.]+)$/, `_${position}$1`);
        gallery.push({ bytes: got.bytes, filename: name, kind: "gallery", ownerPrimary: primaryFilename });
        position++;
      }
      return { row, primary, gallery };
    });

    const survivors = resolvedRows.filter((r): r is ResolvedRow => r !== null);
    const excludedNoImageCount = capped.length - survivors.length;
    if (survivors.length === 0) return { ok: false, error: "no_exportable_rows" };

    // §15 — a post-sanitization primary filename collision aborts generation.
    const collisions = detectFilenameCollisions(survivors.map((s) => s.primary.filename));
    if (collisions.length > 0) return { ok: false, error: "filename_collision" };

    const packageRows: RafeeqPackageRow[] = survivors.map((s) => toPackageRow(s.row, s.primary.filename));
    const rowImageRefs = packageRows.map((r) => r.imageName);

    const packaged: PackagedFile[] = [];
    for (const s of survivors) {
      packaged.push({ name: s.primary.filename, kind: "primary" });
      for (const g of s.gallery) packaged.push({ name: g.filename, kind: "gallery", ownerPrimary: g.ownerPrimary });
    }

    const integrity = checkReferentialIntegrity(rowImageRefs, packaged);
    if (!integrity.ok) return { ok: false, error: "integrity_failed" };

    const xlsxBytes = buildRafeeqXlsxBuffer(packageRows);

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
    for (const s of survivors) {
      entries.push({ name: `${FOLDER}/images/${s.primary.filename}`, data: s.primary.bytes });
      for (const g of s.gallery) entries.push({ name: `${FOLDER}/images/${g.filename}`, data: g.bytes });
    }
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
