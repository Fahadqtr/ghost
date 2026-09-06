// TALABAT.PKGJOB — chunked package-generation ENGINE (PURE). STEP 74.
//
// WHY THIS EXISTS — measured on the real current catalogue (1343 master
// products, 1454 sellable rows, 2501 planned images):
//
//     workbook build                       0.9 s
//     image download 2501 x ~333 KB       ~775 s at concurrency 6   <-- wall
//     ZIP assembly                         8.9 s  (799 MB archive)
//     peak buffered memory                ~1.6 GB                   <-- wall
//
// The single-shot route therefore fails with FUNCTION_INVOCATION_TIMEOUT, and
// would OOM even if the clock allowed it. Two independent ceilings — the 300 s
// function limit and the instance memory limit — so raising maxDuration cannot
// fix it. This engine splits the SAME certified pipeline into bounded steps
// that each fetch a small image batch, write one self-contained ZIP part to
// durable storage, and persist a resumable state. The final artifact is the
// ordered concatenation of the parts — byte-equivalent to the single-shot ZIP
// (STORE entries + central directory; see lib/net/zip segments).
//
// Modelled directly on lib/export/rafeeq/package-job.ts, which already solved
// the identical problem for Rafeeq. No second job system is invented.
//
// PURE: no I/O of its own. All effects go through injected ports (fetchImage /
// putPart / syncMappings / recordAudit), so node:test drives the full lifecycle
// with fakes. It reuses the certified pure helpers (generation set, image plan,
// package rows, manifest, integrity) — never a second algorithm.
//
// PACKAGE CONTENT IS UNCHANGED. Master scope, pricing policy (STEP 72), barcode
// alias (STEP 68), category resolver (STEP 64) and row selection all live
// upstream in the preview and are consumed here verbatim. This module changes
// only HOW MANY REQUESTS the work is spread across.

import { buildTalabatXlsxBuffer } from "../../talabat/package-xlsx.ts";
import { zipEntrySegment, zipDirectorySegment, type ZipSegmentEntry } from "../../net/zip.ts";
import { hashPayload } from "../../platforms/core/hash.ts";
import type { TalabatPreviewRow } from "./preview.ts";
import {
  resolveGenerationSet,
  planRowImages,
  toPackageRow,
  checkReferentialIntegrity,
  buildManifest,
  usesSharedProductImage,
  primaryFilenameFor,
  TALABAT_PACKAGE_LIMITS,
  type TalabatGenerationMode,
  type TalabatPackageRow,
  type PackagedFile,
} from "./package.ts";
import type { TalabatJobErrorCode } from "./package-job-errors.ts";
import type { TalabatJobStage } from "./package-job-errors.ts";

export {
  TALABAT_JOB_ERROR_AR,
  talabatJobErrorMessageAr,
  TALABAT_JOB_STAGES,
  TALABAT_JOB_STAGE_AR,
  type TalabatJobErrorCode,
  type TalabatJobStage,
} from "./package-job-errors.ts";

// ── tuning ────────────────────────────────────────────────────────────────────

/** Bounded work per step: at most this many IMAGES fetched in one request.
 *  2501 images / 40 = ~63 steps, each well inside the function budget. */
export const JOB_STEP_MAX_IMAGES = 40;
/** Soft cap on one part's bytes (Supabase Storage default object limit 50 MB). */
export const JOB_STEP_MAX_PART_BYTES = 40 * 1024 * 1024;
/** A planned image gets this many fetch attempts (across steps) before it is
 *  skipped — transient failures retry rather than failing the whole job. */
export const JOB_IMAGE_ATTEMPTS = 2;

// ── types ─────────────────────────────────────────────────────────────────────

/** One planned image: the exact filename the sheet references and its source. */
export interface TalabatJobPlanImage {
  /** index into plan.rows — the row this image belongs to. */
  rowIndex: number;
  filename: string;
  sourceUrl: string;
  kind: "primary" | "gallery";
  /** for a gallery image: the primary filename it belongs to. */
  ownerPrimary?: string;
}

/** The immutable per-job plan (uploaded once at start; never rewritten). */
export interface TalabatPackageJobPlan {
  version: 1;
  jobId: string;
  mode: TalabatGenerationMode;
  actor: string | null;
  startedAt: string;
  /** the certified, already-validated sellable rows, in deterministic order. */
  rows: TalabatPreviewRow[];
  /** every image the package will contain, in deterministic order. */
  images: TalabatJobPlanImage[];
  counts: {
    simpleProductCount: number;
    variantRowCount: number;
    warningCount: number;
    imageSharedFromProductCount: number;
    excludedBlockedCount: number;
    cappedExcludedCount: number;
  };
}

interface JobEntryRecord extends ZipSegmentEntry {
  part: number;
}

export interface TalabatPackageJobSummary {
  destination: string;
  generatedAt: string;
  actor: string | null;
  outputFilename: string;
  sellableRowCount: number;
  simpleProductCount: number;
  variantRowCount: number;
  productCount: number;
  imageCount: number;
  warningCount: number;
  imageSharedFromProductCount: number;
  excludedBlockedCount: number;
  excludedNoImageCount: number;
  cappedExcludedCount: number;
  manifestFingerprint: string;
  integrityOk: boolean;
}

export interface TalabatMappingSyncResult {
  ok: boolean;
  inserted: number;
  updated: number;
  failed: number;
  /** STEP 76 — bounded-slice progress. */
  totalCandidates: number;
  nextOffset: number;
}

/** The small mutable job state (rewritten after every step; plan lives apart). */
export interface TalabatPackageJobState {
  version: 1;
  jobId: string;
  mode: TalabatGenerationMode;
  status: "running" | "completed" | "failed";
  stage: TalabatJobStage;
  /** next plan.images index to fetch. */
  cursor: number;
  /** fetch attempts spent on plan.images[cursor]. */
  attempts: number;
  /** cumulative archive bytes already committed as parts. */
  offset: number;
  entries: JobEntryRecord[];
  /** filenames successfully packaged (drives the integrity check). */
  packaged: PackagedFile[];
  /** plan.images indexes skipped after exhausting attempts. */
  droppedImages: number[];
  /**
   * STEP 84 — plan filename → the name actually packaged, when the two differ
   * because the bytes were a different format than the URL claimed. Persisted
   * with the state so a resumed job keeps referring to what it already wrote.
   */
  renames?: Record<string, string>;
  /** STEP 84 — what the extension correction found and did. */
  extensionAudit?: ExtensionAuditCounts;
  parts: { path: string; bytes: number }[];
  artifact: {
    filename: string;
    totalBytes: number;
    sha256: string | null;
    manifestFingerprint: string;
    imageCount: number;
  } | null;
  summary: TalabatPackageJobSummary | null;
  mappingSync: TalabatMappingSyncResult | null;
  /**
   * STEP 76 — how many mapping candidates are already persisted, and how many
   * exist in total. The persistence layer costs TWO sequential DB round trips
   * per candidate, so all 1454 in one request is ~2,908 serial calls — the
   * measured cause of the first production finalization stall. The sync is now
   * driven a bounded slice at a time and this cursor survives across steps.
   */
  mappingCursor: number;
  mappingTotal: number | null;
  auditRecorded: boolean;
  error: { code: TalabatJobErrorCode; refId: string } | null;
}

import { decidePackagedName, emptyExtensionAudit, type ExtensionAuditCounts } from "./image-extension.ts";

export interface TalabatJobPorts {
  /** SSRF-safe validated fetch (server wires the certified boundary). null = failed/invalid. */
  fetchImage(url: string): Promise<{ bytes: Uint8Array; ext: string } | null>;
  /** Durable, idempotent write of one artifact part (same path may be overwritten). */
  putPart(path: string, bytes: Uint8Array): Promise<void>;
}

export interface TalabatJobAdvanceDeps {
  ports: TalabatJobPorts;
  /** Talabat channel mapping sync — invoked at most ONCE per job, after the
   *  artifact is fully committed. Absent = never synced. */
  syncMappings?: (actor: string | null, offset: number) => Promise<TalabatMappingSyncResult>;
  /** The single malak_audit trail row — invoked at most ONCE per job, last. */
  recordAudit?: (summary: TalabatPackageJobSummary) => Promise<boolean>;
  budget?: { maxImages?: number; maxPartBytes?: number };
  /**
   * STEP 84 — make each packaged filename agree with its actual bytes.
   *
   * OPT-IN, default false, because the certified full package has shipped with
   * URL-derived names and changing them silently would alter a certified
   * artifact. The new-product delta package turns it on; nothing else does.
   */
  correctExtensionFromBytes?: boolean;
  /**
   * STEP 90 — archive the IMAGES ONLY, omitting the workbook and manifest.
   *
   * OPT-IN, default false, for the same reason as the flag above: the certified
   * full package must stay byte-for-byte what it has always been.
   *
   * The Email B delivery is an Excel ATTACHMENT plus an images link. If the
   * linked ZIP also carried a workbook, Talabat would receive two different
   * spreadsheets in one delivery — this one built from the full certified
   * schema, the attached one from the new-product delta — and could import the
   * wrong one. Row selection, survivor rules and the §15 integrity check are
   * unchanged; only the two tail ENTRIES are left out of the archive.
   */
  imagesOnlyArchive?: boolean;
}

// ── plan / state construction ─────────────────────────────────────────────────

export function jobPartPath(jobId: string, part: number): string {
  return `jobs/${jobId}/part-${String(part).padStart(5, "0")}`;
}

export function talabatJobZipName(nowIso: string): string {
  return `talabat-package-${nowIso.slice(0, 10)}.zip`;
}

/**
 * Build the immutable plan from the certified preview rows. This is the ONLY
 * place row selection happens, and it delegates entirely to the certified
 * resolveGenerationSet + planRowImages — no second selection algorithm.
 */
export function createTalabatPackageJob(input: {
  jobId: string;
  mode: TalabatGenerationMode;
  selectedKeys?: readonly string[];
  previewRows: readonly TalabatPreviewRow[];
  actor: string | null;
  nowIso: string;
}):
  | { ok: true; plan: TalabatPackageJobPlan; state: TalabatPackageJobState }
  | { ok: false; error: "no_exportable_rows" } {
  const set = resolveGenerationSet(input.previewRows, { mode: input.mode, selectedKeys: input.selectedKeys });
  const capped = set.included.slice(0, TALABAT_PACKAGE_LIMITS.maxRows);
  if (capped.length === 0) return { ok: false, error: "no_exportable_rows" };

  const images: TalabatJobPlanImage[] = [];
  for (let i = 0; i < capped.length; i++) {
    const plan = planRowImages(capped[i]);
    if (plan.primary) {
      images.push({
        rowIndex: i, filename: plan.primary.filename,
        sourceUrl: plan.primary.sourceUrl, kind: "primary",
      });
      for (const g of plan.gallery) {
        images.push({
          rowIndex: i, filename: g.filename, sourceUrl: g.sourceUrl,
          kind: "gallery", ownerPrimary: plan.primary.filename,
        });
      }
    }
  }

  const plan: TalabatPackageJobPlan = {
    version: 1,
    jobId: input.jobId,
    mode: input.mode,
    actor: input.actor,
    startedAt: input.nowIso,
    rows: [...capped],
    images,
    counts: {
      simpleProductCount: capped.filter((r) => !r.isVariant).length,
      variantRowCount: capped.filter((r) => r.isVariant).length,
      warningCount: set.counts.warnings,
      imageSharedFromProductCount: capped.filter((r) => usesSharedProductImage(r)).length,
      excludedBlockedCount: set.excludedBlocked.length,
      cappedExcludedCount: set.included.length - capped.length,
    },
  };
  const state: TalabatPackageJobState = {
    version: 1,
    jobId: input.jobId,
    mode: input.mode,
    status: "running",
    stage: images.length > 0 ? "DOWNLOADING_IMAGES" : "BUILDING_WORKBOOK",
    cursor: 0,
    attempts: 0,
    offset: 0,
    entries: [],
    packaged: [],
    droppedImages: [],
    parts: [],
    artifact: null,
    summary: null,
    mappingSync: null,
    mappingCursor: 0,
    mappingTotal: null,
    auditRecorded: false,
    error: null,
  };
  return { ok: true, plan, state };
}

/** Progress for the status endpoint / UI. Totals come from the real plan. */
export function jobProgress(
  state: TalabatPackageJobState,
  plan: Pick<TalabatPackageJobPlan, "images" | "rows">,
): {
  stage: TalabatJobStage;
  progressCurrent: number;
  progressTotal: number;
  progressPercent: number;
  imagesDone: number;
  imagesTotal: number;
  rowsTotal: number;
  bytesDone: number;
} {
  const total = plan.images.length;
  const done = Math.min(state.cursor, total);
  // The image phase IS the long pole (measured 775 s of 785 s), so percent is
  // driven by it; finalize contributes the last sliver.
  const percent =
    state.status === "completed" ? 100
      : total === 0 ? (state.status === "running" ? 0 : 100)
        : Math.min(99, Math.floor((done / total) * 100));
  return {
    stage: state.stage,
    progressCurrent: done,
    progressTotal: total,
    progressPercent: percent,
    imagesDone: done,
    imagesTotal: total,
    rowsTotal: plan.rows.length,
    bytesDone: state.offset,
  };
}

function refId(state: TalabatPackageJobState): string {
  return `${state.jobId.slice(0, 8)}-p${state.parts.length}-c${state.cursor}`;
}

// ── the step ──────────────────────────────────────────────────────────────────

/**
 * Advance the job by ONE bounded step. Running out of planned images → the
 * finalize steps (workbook + directory tail, then mapping sync, then audit).
 * A completed/failed job is a no-op (idempotent). The returned state is a new
 * object; the caller persists it and the part files are already durable.
 */
export async function advanceTalabatPackageJob(
  stateIn: TalabatPackageJobState,
  plan: TalabatPackageJobPlan,
  deps: TalabatJobAdvanceDeps,
): Promise<TalabatPackageJobState> {
  if (stateIn.status !== "running") return stateIn;
  const state: TalabatPackageJobState = JSON.parse(JSON.stringify(stateIn));
  try {
    if (state.cursor < plan.images.length) return await imageStep(state, plan, deps);
    if (state.artifact === null) return await archiveStep(state, plan, deps);
    if (deps.syncMappings && !mappingComplete(state)) return await mappingStep(state, deps);
    return await finalizeStep(state, deps);
  } catch {
    state.status = "failed";
    // STEP 76 — classify. Once the artifact is durable in storage every
    // remaining step is cheap bookkeeping, so a failure there is RECOVERABLE:
    // the job keeps its parts and resumes at finalization rather than
    // re-downloading 2501 images. Only a failure BEFORE the artifact exists is
    // unrecoverable and eligible for cleanup.
    state.error = state.artifact !== null
      ? { code: "upload_incomplete", refId: refId(state) }
      : { code: "generation_failed", refId: refId(state) };
    return state;
  }
}

/** Fetch a bounded batch of images and commit them as ONE archive part. */
async function imageStep(
  state: TalabatPackageJobState,
  plan: TalabatPackageJobPlan,
  deps: TalabatJobAdvanceDeps,
): Promise<TalabatPackageJobState> {
  const maxImages = deps.budget?.maxImages ?? JOB_STEP_MAX_IMAGES;
  const maxBytes = deps.budget?.maxPartBytes ?? JOB_STEP_MAX_PART_BYTES;
  state.stage = "DOWNLOADING_IMAGES";

  const segments: Uint8Array[] = [];
  const partIndex = state.parts.length;
  let partBytes = 0;
  let fetched = 0;

  while (state.cursor < plan.images.length && fetched < maxImages && partBytes < maxBytes) {
    const img = plan.images[state.cursor];
    const got = await deps.ports.fetchImage(img.sourceUrl);
    if (got === null) {
      state.attempts += 1;
      if (state.attempts >= JOB_IMAGE_ATTEMPTS) {
        // Exhausted: skip this image. A missing gallery image never fails the
        // job; a missing PRIMARY drops its row from the sheet at finalize.
        state.droppedImages.push(state.cursor);
        state.cursor += 1;
        state.attempts = 0;
      }
      // Leave the cursor put on a retryable failure — the next step retries it.
      break;
    }
    state.attempts = 0;

    // STEP 84 — the packaged name must not lie about the bytes. Default OFF,
    // so the certified full package is byte-for-byte what it has always been.
    let packagedName = img.filename;
    if (deps.correctExtensionFromBytes) {
      const audit = (state.extensionAudit ??= emptyExtensionAudit());
      const decision = decidePackagedName(img.filename, got.ext, new Set(state.packaged.map((p) => p.name)));
      if (decision.action === "rename") {
        audit.mismatches += 1; audit.renamed += 1;
        packagedName = decision.name;
        (state.renames ??= {})[img.filename] = decision.name;
      } else if (decision.action === "collision") {
        // Corrected name already taken: keep the original and report it UNFIXED
        // so the preflight blocks, rather than overwrite a different image.
        audit.mismatches += 1; audit.collisions += 1;
      }
    }
    // A gallery names its owning primary; if that primary was renamed, the
    // reference has to follow or the §15 integrity check would orphan it.
    const ownerPrimary = img.ownerPrimary
      ? state.renames?.[img.ownerPrimary] ?? img.ownerPrimary
      : undefined;

    const entryName = `Talabat/images/${packagedName}`;
    const seg = zipEntrySegment(entryName, got.bytes);
    state.entries.push({
      name: entryName, crc: seg.crc, size: seg.size,
      offset: state.offset + partBytes, part: partIndex,
    });
    state.packaged.push({
      name: packagedName,
      kind: img.kind,
      ...(ownerPrimary ? { ownerPrimary } : {}),
    });
    segments.push(seg.bytes);
    partBytes += seg.bytes.length;
    fetched += 1;
    state.cursor += 1;
  }

  if (segments.length > 0) {
    const path = jobPartPath(plan.jobId, partIndex);
    await deps.ports.putPart(path, concatBytes(segments));
    state.parts.push({ path, bytes: partBytes });
    state.offset += partBytes;
  }
  return state;
}

/**
 * Build the workbook from the SURVIVING rows, append it plus the central
 * directory as the closing part, and record the artifact. This is where
 * BUILDING_WORKBOOK / BUILDING_ARCHIVE / UPLOADING_ARTIFACT happen — measured
 * at ~10 s total, comfortably inside one request.
 */
async function archiveStep(
  state: TalabatPackageJobState,
  plan: TalabatPackageJobPlan,
  deps: TalabatJobAdvanceDeps,
): Promise<TalabatPackageJobState> {
  state.stage = "BUILDING_WORKBOOK";

  // A row survives only when its PRIMARY image was packaged — identical to the
  // single-shot generator's excludedNoImage rule.
  const primaryByRow = new Map<number, string>();
  for (const img of plan.images) {
    if (img.kind !== "primary") continue;
    // resolve through the rename map so a corrected filename is the one the
    // sheet cites — otherwise the workbook would reference a file that the
    // archive does not contain under that name.
    const packagedName = state.renames?.[img.filename] ?? img.filename;
    if (state.packaged.some((p) => p.name === packagedName)) primaryByRow.set(img.rowIndex, packagedName);
  }
  const survivors: { row: TalabatPreviewRow; filename: string }[] = [];
  for (let i = 0; i < plan.rows.length; i++) {
    const f = primaryByRow.get(i);
    if (f) survivors.push({ row: plan.rows[i], filename: f });
  }
  if (survivors.length === 0) {
    state.status = "failed";
    state.error = { code: "no_exportable_rows", refId: refId(state) };
    return state;
  }

  const packageRows: TalabatPackageRow[] = survivors.map((s) => toPackageRow(s.row, s.filename));
  const xlsxBytes = buildTalabatXlsxBuffer(packageRows);

  // §15 referential integrity — every filename the sheet names must exist.
  const integrity = checkReferentialIntegrity(packageRows.map((r) => r.imageFilename), state.packaged);
  if (!integrity.ok) {
    state.status = "failed";
    state.error = { code: "integrity_failed", refId: refId(state) };
    return state;
  }

  const generatedAt = new Date().toISOString();
  const outputFilename = talabatJobZipName(generatedAt);
  const summary: TalabatPackageJobSummary = {
    destination: "talabat:malikas",
    generatedAt,
    actor: plan.actor,
    outputFilename,
    sellableRowCount: survivors.length,
    simpleProductCount: survivors.filter((s) => !s.row.isVariant).length,
    variantRowCount: survivors.filter((s) => s.row.isVariant).length,
    productCount: new Set(survivors.map((s) => s.row.internalProductId)).size,
    imageCount: state.packaged.length,
    warningCount: plan.counts.warningCount,
    imageSharedFromProductCount: survivors.filter((s) => usesSharedProductImage(s.row)).length,
    excludedBlockedCount: plan.counts.excludedBlockedCount,
    excludedNoImageCount: plan.rows.length - survivors.length,
    cappedExcludedCount: plan.counts.cappedExcludedCount,
    manifestFingerprint: "",
    integrityOk: true,
  };

  const manifest = buildManifest({
    destination: summary.destination,
    generatedAt,
    actor: plan.actor,
    simpleProductCount: summary.simpleProductCount,
    variantRowCount: summary.variantRowCount,
    sellableRowCount: summary.sellableRowCount,
    imageCount: summary.imageCount,
    warningCount: summary.warningCount,
    imageSharedFromProductCount: summary.imageSharedFromProductCount,
    excludedBlockedCount: summary.excludedBlockedCount,
    outputFilename,
    previewReference: { jobId: plan.jobId, mode: plan.mode, plannedImages: plan.images.length },
  });
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
  // The Talabat manifest carries no fingerprint field of its own, so the
  // fingerprint IS the content digest of the manifest — computed with the
  // existing shared hashPayload (canonical, key-order independent), never a
  // second hashing scheme.
  summary.manifestFingerprint = hashPayload(manifest);

  state.stage = "BUILDING_ARCHIVE";
  const tail: Uint8Array[] = [];
  let tailBytes = 0;
  // The workbook and manifest are still BUILT above — they decide which rows
  // survive and they drive the integrity check — but an images-only archive
  // does not carry them.
  const tailEntries: [string, Uint8Array][] = deps.imagesOnlyArchive
    ? []
    : [["Talabat/talabat-products.xlsx", xlsxBytes], ["manifest.json", manifestBytes]];
  for (const [name, data] of tailEntries) {
    const seg = zipEntrySegment(name, data);
    state.entries.push({ name, crc: seg.crc, size: seg.size, offset: state.offset + tailBytes, part: state.parts.length });
    tail.push(seg.bytes);
    tailBytes += seg.bytes.length;
  }
  const directory = zipDirectorySegment(state.entries);
  tail.push(directory);
  tailBytes += directory.length;

  state.stage = "UPLOADING_ARTIFACT";
  const path = jobPartPath(plan.jobId, state.parts.length);
  await deps.ports.putPart(path, concatBytes(tail));
  state.parts.push({ path, bytes: tailBytes });
  state.offset += tailBytes;

  state.summary = summary;
  state.artifact = {
    filename: outputFilename,
    totalBytes: state.offset,
    sha256: null, // computed by the server layer when it streams the parts
    manifestFingerprint: summary.manifestFingerprint,
    imageCount: summary.imageCount,
  };
  return state;
}

/** A non-negative integer, or null when the value is missing/nonsensical. */
export function counter(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;
}

/**
 * STEP 77 — normalise a state object read back from storage.
 *
 * Job state is persisted as plain JSON and read back with a bare cast, so a
 * state written by an OLDER build simply lacks the fields that build did not
 * know about. STEP 76 added `mappingCursor` / `mappingTotal`; a job created
 * before it deployed reads them as `undefined`, and `undefined` silently poisons
 * every comparison it touches — `200 > undefined` is false, so the cursor never
 * advanced, and `undefined >= undefined` is false, so the stage never completed.
 * Production job ad8aa4db looped the first 200 mapping candidates for ~30
 * minutes that way: its images and its 64 archive parts were all intact, and it
 * still could not reach FINALIZING.
 *
 * Normalising ONCE at the read boundary is what makes that class of bug
 * impossible rather than fixing this one instance of it: every consumer is then
 * guaranteed real numbers, so no downstream comparison can meet `undefined`.
 * Unknown/extra keys are preserved untouched, so a state written by a NEWER
 * build survives a rollback intact.
 */
export function normalizeTalabatPackageJobState(raw: unknown): TalabatPackageJobState | null {
  if (raw === null || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  // Identity must be real; anything else is not a job state.
  if (typeof s.jobId !== "string" || s.jobId === "") return null;
  const cursor = counter(s.mappingCursor) ?? 0;
  const total = counter(s.mappingTotal);
  return {
    ...(raw as TalabatPackageJobState),
    mappingCursor: cursor,
    // A total below the cursor would report the stage complete before its work
    // is done, so an out-of-range value degrades to "unknown" (null), never to a
    // smaller number.
    mappingTotal: total !== null && total >= cursor ? total : null,
  };
}

/** True once every mapping candidate has been persisted. */
export function mappingComplete(state: TalabatPackageJobState): boolean {
  const total = counter(state.mappingTotal);
  // Unknown total (null, or anything not a real count) = not yet complete.
  if (total === null) return false;
  return (counter(state.mappingCursor) ?? 0) >= total;
}

/**
 * Talabat channel mapping sync — a BOUNDED slice per step, resumed via
 * mappingCursor. Each candidate costs two sequential DB round trips, so the
 * full 1454 in one request (~2,908 serial calls) is what stalled the first
 * production run; slicing keeps every step inside the function budget.
 *
 * TERMINATION is guaranteed and does not rely on the injected sync behaving.
 * The stage is marked complete — mappingTotal pinned to the cursor — whenever
 * the slice reports a failure, reports no bounded total (an implementation
 * that syncs everything in one call), or fails to move the cursor forward.
 * Without that, a sync that never advances would spin the job for ever.
 */
async function mappingStep(
  state: TalabatPackageJobState,
  deps: TalabatJobAdvanceDeps,
): Promise<TalabatPackageJobState> {
  state.stage = "SYNCING_MAPPINGS";
  const res = await deps.syncMappings!(state.summary?.actor ?? null, state.mappingCursor);

  const total = counter(res.totalCandidates);
  const next = counter(res.nextOffset);
  // Read through counter() as well: normalizeTalabatPackageJobState guarantees a
  // real number at the read boundary, and this keeps the step correct even if a
  // caller ever hands the engine an unnormalised state directly.
  const cursor = counter(state.mappingCursor) ?? 0;
  const advanced = next !== null && next > cursor;
  state.mappingCursor = advanced ? next : cursor;
  // Stop slicing when the sync failed, reported no bounded total, or made no
  // forward progress: pin the total to the cursor so mappingComplete() is true.
  state.mappingTotal = res.ok && total !== null && advanced ? total : state.mappingCursor;

  const prev = state.mappingSync;
  state.mappingSync = {
    ok: (prev?.ok ?? true) && res.ok,
    inserted: (prev?.inserted ?? 0) + (counter(res.inserted) ?? 0),
    updated: (prev?.updated ?? 0) + (counter(res.updated) ?? 0),
    failed: (prev?.failed ?? 0) + (counter(res.failed) ?? 0),
    totalCandidates: total ?? state.mappingCursor,
    nextOffset: state.mappingCursor,
  };
  return state;
}

/** The single malak_audit trail row, then the job is complete. */
async function finalizeStep(
  state: TalabatPackageJobState,
  deps: TalabatJobAdvanceDeps,
): Promise<TalabatPackageJobState> {
  state.stage = "FINALIZING";
  if (deps.recordAudit && !state.auditRecorded && state.summary) {
    state.auditRecorded = await deps.recordAudit(state.summary);
  }
  state.stage = "COMPLETED";
  state.status = "completed";
  return state;
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/** Deterministic primary filename for a row — re-exported for the server layer. */
export { primaryFilenameFor };
