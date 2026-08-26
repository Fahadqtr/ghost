// RAFEEQ.PKGJOB — chunked package-generation ENGINE (PURE).
//
// Why this exists: generating the FULL native package (~1419 products,
// ~2535 images, ~500 MiB) inside ONE serverless request buffers every image
// plus the whole ZIP in memory — Vercel kills the instance ("out of available
// memory", runtime error log 2026-08-25) and once hit the 300 s ceiling. This
// engine splits the SAME certified pipeline into bounded steps that each fetch
// a small batch of images, write one self-contained ZIP part to durable
// storage, and persist a resumable state. The final artifact is the ordered
// concatenation of the parts — byte-equivalent to the single-shot ZIP
// (STORE entries + central directory; see lib/net/zip segments).
//
// PURE: no I/O of its own. All effects go through injected ports (fetchImage /
// putPart / recordPackage), so node:test drives the full lifecycle with fakes.
// It reuses the certified pure helpers (selection, image plan, package rows,
// reference sheet, manifest, fingerprints) — never a second algorithm.
//
// Safety invariants (unchanged from the single-shot generator):
//   • catalog/ECL/data writes: NONE (the only durable write is the package
//     history record, injected by the server layer and invoked EXACTLY ONCE
//     per job, only after the artifact is fully committed to storage);
//   • ids never invented; blocked rows never packaged; one image set per
//     product; §15 filename-collision and referential-integrity checks kept;
//   • a retried/resumed step is idempotent: parts are addressed by index and
//     recomputed deterministically from the persisted state.

import { buildRafeeqXlsxBuffer } from "../../rafeeq/package-xlsx.ts";
import { zipEntrySegment, zipDirectorySegment, type ZipSegmentEntry } from "../../net/zip.ts";
import type { RafeeqPreviewRow } from "./preview.ts";
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
  type RafeeqPendingKind,
} from "./fullsync.ts";
import {
  planRowImages,
  toPackageRow,
  checkReferentialIntegrity,
  detectFilenameCollisions,
  primaryFilenameFor,
  physicalRowCount,
  RAFEEQ_NEW_MARKER,
  PACKAGE_LIMITS,
  type RafeeqPackageRow,
  type PackagedFile,
} from "./package.ts";
import { buildMalikasReferenceAoa } from "./reference.ts";
import { buildOptionsOverviewSheet } from "./options-overview.ts";

// ── tuning ────────────────────────────────────────────────────────────────────

/** Bounded work per step: at most this many PRODUCTS (primary + gallery). */
export const JOB_STEP_MAX_PRODUCTS = 24;
/** Soft cap on one part's bytes (Supabase Storage default object limit 50 MB). */
export const JOB_STEP_MAX_PART_BYTES = 40 * 1024 * 1024;
/** A primary image gets this many fetch attempts (across steps) before the
 *  product is dropped as excluded-no-image — transient failures retry. */
export const JOB_PRIMARY_ATTEMPTS = 2;

// ── types ─────────────────────────────────────────────────────────────────────

import type { RafeeqJobErrorCode } from "./package-job-errors.ts";
export { RAFEEQ_JOB_ERROR_AR, rafeeqJobErrorMessageAr, type RafeeqJobErrorCode } from "./package-job-errors.ts";

export interface RafeeqJobPlanProduct {
  row: RafeeqPreviewRow;
  kind?: RafeeqPendingKind;
}

/** The immutable per-job plan (uploaded once at start; never rewritten). */
export interface RafeeqPackageJobPlan {
  version: 1;
  jobId: string;
  mode: RafeeqFullSyncMode;
  actor: string | null;
  startedAt: string;
  products: RafeeqJobPlanProduct[];
  counts: {
    trueBlockersExcluded: number;
    alreadySentExcluded: number;
    optionUpdateCount: number;
    cappedExcludedCount: number;
  };
}

interface JobEntryRecord extends ZipSegmentEntry {
  part: number;
}

interface JobSurvivor {
  /** index into plan.products. */
  index: number;
  primaryFilename: string;
  galleryFilenames: string[];
}

export interface RafeeqPackageJobSummary {
  mode: RafeeqFullSyncMode;
  generatedAt: string;
  actor: string | null;
  outputFilename: string;
  xlsxFilename: string;
  productRowCount: number;
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

export interface RafeeqPackageJobItem {
  productId: string;
  variantId: null;
  sku: string;
  fingerprint: string;
  rafeeqIdSent: string;
}

export interface RafeeqPackageJobRecorded {
  persisted: boolean;
  packageId: string | null;
  itemsPersisted: number;
  supersededCount: number;
}

/** The small mutable job state (rewritten after every step; plan lives apart). */
export interface RafeeqPackageJobState {
  version: 1;
  jobId: string;
  mode: RafeeqFullSyncMode;
  status: "running" | "complete" | "failed";
  /** next plan index to process. */
  cursor: number;
  /** fetch attempts spent on plan[cursor]'s primary image. */
  attempts: number;
  /** cumulative archive bytes already committed as parts. */
  offset: number;
  entries: JobEntryRecord[];
  survivors: JobSurvivor[];
  droppedNoImage: number[];
  parts: { path: string; bytes: number }[];
  artifact: {
    filename: string;
    xlsxFilename: string;
    totalBytes: number;
    manifestFingerprint: string;
    imageCount: number;
  } | null;
  summary: RafeeqPackageJobSummary | null;
  items: RafeeqPackageJobItem[] | null;
  packageRecorded: RafeeqPackageJobRecorded | null;
  error: { code: RafeeqJobErrorCode; refId: string } | null;
}

export interface RafeeqJobPorts {
  /** SSRF-safe validated fetch (server wires the certified boundary). null = failed/invalid. */
  fetchImage(url: string): Promise<{ bytes: Uint8Array; ext: string } | null>;
  /** Durable, idempotent write of one artifact part (same path may be overwritten). */
  putPart(path: string, bytes: Uint8Array): Promise<void>;
}

export interface RafeeqJobAdvanceDeps {
  ports: RafeeqJobPorts;
  /** Durable package-history recorder — invoked at most ONCE per job, only
   *  after the artifact is fully committed. Absent = never recorded. */
  recordPackage?: (input: {
    mode: RafeeqFullSyncMode;
    outputFilename: string;
    manifestFingerprint: string;
    productCount: number;
    imageCount: number;
    generatedAt: string;
    actor: string | null;
    items: RafeeqPackageJobItem[];
  }) => Promise<RafeeqPackageJobRecorded>;
  budget?: { maxProducts?: number; maxPartBytes?: number };
}

// ── plan / state construction ─────────────────────────────────────────────────

export function jobPartPath(jobId: string, part: number): string {
  return `jobs/${jobId}/part-${String(part).padStart(5, "0")}`;
}

export function createRafeeqPackageJob(input: {
  jobId: string;
  mode: RafeeqFullSyncMode;
  previewRows: readonly RafeeqPreviewRow[];
  sentBaseline: ReadonlyMap<string, string | null>;
  actor: string | null;
  nowIso: string;
}): { ok: true; plan: RafeeqPackageJobPlan; state: RafeeqPackageJobState } | { ok: false; error: "no_exportable_rows" } {
  const set = resolveFullSyncSet(input.previewRows, input.mode, input.sentBaseline);
  const capped = set.included.slice(0, PACKAGE_LIMITS.maxRows);
  if (capped.length === 0) return { ok: false, error: "no_exportable_rows" };

  const plan: RafeeqPackageJobPlan = {
    version: 1,
    jobId: input.jobId,
    mode: input.mode,
    actor: input.actor,
    startedAt: input.nowIso,
    products: capped.map((row) => ({ row, kind: set.includedKinds.get(deliveryKeyOfRow(row)) })),
    counts: {
      trueBlockersExcluded: set.counts.trueBlockers,
      alreadySentExcluded: set.excludedAlreadySent.length,
      optionUpdateCount: set.counts.optionUpdates,
      cappedExcludedCount: set.included.length - capped.length,
    },
  };
  const state: RafeeqPackageJobState = {
    version: 1,
    jobId: input.jobId,
    mode: input.mode,
    status: "running",
    cursor: 0,
    attempts: 0,
    offset: 0,
    entries: [],
    survivors: [],
    droppedNoImage: [],
    parts: [],
    artifact: null,
    summary: null,
    items: null,
    packageRecorded: null,
    error: null,
  };
  return { ok: true, plan, state };
}

/** Coarse progress for the status endpoint / UI. */
export function jobProgress(state: RafeeqPackageJobState, plan: Pick<RafeeqPackageJobPlan, "products">): {
  productsDone: number;
  productsTotal: number;
  imagesDone: number;
  bytesDone: number;
  phase: "images" | "finalize" | "done" | "failed";
} {
  return {
    productsDone: Math.min(state.cursor, plan.products.length),
    productsTotal: plan.products.length,
    imagesDone: state.entries.length,
    bytesDone: state.offset,
    phase: state.status === "failed" ? "failed" : state.status === "complete" ? "done" : state.cursor < plan.products.length ? "images" : "finalize",
  };
}

function refId(state: RafeeqPackageJobState): string {
  return `${state.jobId.slice(0, 8)}-p${state.parts.length}-c${state.cursor}`;
}

// ── the step ──────────────────────────────────────────────────────────────────

/**
 * Advance the job by ONE bounded step. Running out of plan → the finalize
 * step (validation + xlsx/manifest/directory tail + one-time history record).
 * A completed/failed job is a no-op (idempotent). The returned state is a new
 * object; the caller persists it and the part files are already durable.
 */
export async function advanceRafeeqPackageJob(
  stateIn: RafeeqPackageJobState,
  plan: RafeeqPackageJobPlan,
  deps: RafeeqJobAdvanceDeps,
): Promise<RafeeqPackageJobState> {
  if (stateIn.status !== "running") return stateIn;
  const state: RafeeqPackageJobState = JSON.parse(JSON.stringify(stateIn));
  try {
    if (state.cursor < plan.products.length) return await imageStep(state, plan, deps);
    return await finalizeStep(state, plan, deps);
  } catch {
    state.status = "failed";
    state.error = { code: "generation_failed", refId: refId(state) };
    return state;
  }
}

async function imageStep(
  state: RafeeqPackageJobState,
  plan: RafeeqPackageJobPlan,
  deps: RafeeqJobAdvanceDeps,
): Promise<RafeeqPackageJobState> {
  const maxProducts = deps.budget?.maxProducts ?? JOB_STEP_MAX_PRODUCTS;
  const maxPartBytes = deps.budget?.maxPartBytes ?? JOB_STEP_MAX_PART_BYTES;
  const chunks: Uint8Array[] = [];
  const newEntries: JobEntryRecord[] = [];
  let chunkBytes = 0;
  let productsInChunk = 0;
  const partIndex = state.parts.length;

  while (state.cursor < plan.products.length && productsInChunk < maxProducts && chunkBytes < maxPartBytes) {
    const { row } = plan.products[state.cursor];
    const imagePlan = planRowImages(row);
    if (!imagePlan.primary) {
      state.droppedNoImage.push(state.cursor);
      state.cursor += 1;
      state.attempts = 0;
      continue;
    }
    const primaryFetch = await deps.ports.fetchImage(imagePlan.primary.sourceUrl);
    if (!primaryFetch) {
      state.attempts += 1;
      if (state.attempts < JOB_PRIMARY_ATTEMPTS) break; // transient → retry on the NEXT step
      state.droppedNoImage.push(state.cursor);          // exhausted → excluded-no-image
      state.cursor += 1;
      state.attempts = 0;
      continue;
    }
    state.attempts = 0;
    const primaryFilename = primaryFilenameFor(row.sku, primaryFetch.ext);
    const survivor: JobSurvivor = { index: state.cursor, primaryFilename, galleryFilenames: [] };
    const files: { name: string; bytes: Uint8Array }[] = [
      { name: fullSyncImageEntryName(primaryFilename), bytes: primaryFetch.bytes },
    ];
    let position = 2;
    for (const g of imagePlan.gallery) {
      const got = await deps.ports.fetchImage(g.sourceUrl);
      if (!got) continue; // gallery images are optional — a failure skips the file
      const name = primaryFilenameFor(row.sku, got.ext).replace(/(\.[^.]+)$/, `_${position}$1`);
      survivor.galleryFilenames.push(name);
      files.push({ name: fullSyncImageEntryName(name), bytes: got.bytes });
      position += 1;
    }
    for (const f of files) {
      const seg = zipEntrySegment(f.name, f.bytes);
      newEntries.push({ name: f.name, crc: seg.crc, size: seg.size, offset: state.offset + chunkBytes, part: partIndex });
      chunks.push(seg.bytes);
      chunkBytes += seg.bytes.length;
    }
    state.survivors.push(survivor);
    state.cursor += 1;
    productsInChunk += 1;
  }

  if (chunkBytes > 0) {
    const part = new Uint8Array(chunkBytes);
    let at = 0;
    for (const c of chunks) {
      part.set(c, at);
      at += c.length;
    }
    const path = jobPartPath(state.jobId, partIndex);
    await deps.ports.putPart(path, part);
    state.parts.push({ path, bytes: chunkBytes });
    state.entries.push(...newEntries);
    state.offset += chunkBytes;
  }
  return state;
}

async function finalizeStep(
  state: RafeeqPackageJobState,
  plan: RafeeqPackageJobPlan,
  deps: RafeeqJobAdvanceDeps,
): Promise<RafeeqPackageJobState> {
  const fail = (code: RafeeqJobErrorCode): RafeeqPackageJobState => {
    state.status = "failed";
    state.error = { code, refId: refId(state) };
    return state;
  };

  if (state.survivors.length === 0) return fail("no_exportable_rows");

  // §15 — a post-sanitization primary filename collision aborts generation.
  const collisions = detectFilenameCollisions(state.survivors.map((sv) => sv.primaryFilename));
  if (collisions.length > 0) return fail("filename_collision");

  const survivorsWith = state.survivors.map((sv) => ({ sv, product: plan.products[sv.index] }));
  const packageRows: RafeeqPackageRow[] = survivorsWith.map(({ sv, product }) =>
    applyFullSyncRafeeqId(toPackageRow(product.row, sv.primaryFilename), product.row, plan.mode, product.kind),
  );
  const packaged: PackagedFile[] = [];
  for (const { sv } of survivorsWith) {
    packaged.push({ name: sv.primaryFilename, kind: "primary" });
    for (const g of sv.galleryFilenames) packaged.push({ name: g, kind: "gallery", ownerPrimary: sv.primaryFilename });
  }
  const integrity = checkReferentialIntegrity(packageRows.map((r) => r.imageName), packaged);
  if (!integrity.ok) return fail("integrity_failed");

  const referenceAoa = buildMalikasReferenceAoa(survivorsWith.map(({ sv, product }, i) => ({
    row: product.row,
    imageFilename: sv.primaryFilename,
    productIdCell: packageRows[i].rafeeqId,
    kind: product.kind,
  })));
  // Third sheet — ONLY the option parents, one visual block each (clarity only).
  const optionsOverview = buildOptionsOverviewSheet(
    survivorsWith.map(({ sv, product }) => ({ row: product.row, imageFilename: sv.primaryFilename })),
  );
  const xlsxBytes = buildRafeeqXlsxBuffer(packageRows, referenceAoa, optionsOverview);

  const items: RafeeqPackageJobItem[] = survivorsWith.map(({ product }, i) => ({
    productId: product.row.internalProductId,
    variantId: null,
    sku: product.row.sku,
    fingerprint: rowFingerprint(product.row),
    rafeeqIdSent: packageRows[i].rafeeqId || RAFEEQ_NEW_MARKER,
  }));
  const manifestFingerprint = packageFingerprint(plan.mode, items.map((it) => it.fingerprint));

  const now = new Date(plan.startedAt);
  const outputFilename = fullSyncZipName(plan.mode, now);
  const xlsxFilename = fullSyncXlsxName(plan.mode);
  const newMarkerCount = packageRows.filter((r) => r.rafeeqId === "").length;
  const imageCount = packaged.length;

  const manifest = buildFullSyncManifest({
    storefrontKey: "rafeeq:malikas",
    mode: plan.mode,
    generatedAt: plan.startedAt,
    actor: plan.actor,
    productRowCount: packageRows.length,
    physicalRowCount: physicalRowCount(packageRows),
    productsWithOptions: survivorsWith.filter(({ product }) => product.row.hasOptions).length,
    optionCount: survivorsWith.reduce((acc, { product }) => acc + product.row.optionCount, 0),
    optionUpdateCount: plan.counts.optionUpdateCount,
    imageCount,
    mappedIdCount: packageRows.length - newMarkerCount,
    newMarkerCount,
    needsReviewIncluded: survivorsWith.filter(({ product }) => product.row.needsOwnerReview).length,
    trueBlockersExcluded: plan.counts.trueBlockersExcluded,
    outputFilename,
    xlsxFilename,
    packageFingerprint: manifestFingerprint,
  });

  // Tail part: xlsx entry + manifest entry + central directory + EOCD. Entry
  // ORDER in the archive is irrelevant to the layout contract (root names).
  const xlsxSeg = zipEntrySegment(xlsxFilename, new Uint8Array(xlsxBytes));
  const manifestSeg = zipEntrySegment(FULLSYNC_MANIFEST_NAME, new TextEncoder().encode(JSON.stringify(manifest, null, 2)));
  const allEntries: ZipSegmentEntry[] = [
    ...state.entries.map((e) => ({ name: e.name, crc: e.crc, size: e.size, offset: e.offset })),
    { name: xlsxFilename, crc: xlsxSeg.crc, size: xlsxSeg.size, offset: state.offset },
    { name: FULLSYNC_MANIFEST_NAME, crc: manifestSeg.crc, size: manifestSeg.size, offset: state.offset + xlsxSeg.bytes.length },
  ];
  const directory = zipDirectorySegment(allEntries);
  const tail = new Uint8Array(xlsxSeg.bytes.length + manifestSeg.bytes.length + directory.length);
  tail.set(xlsxSeg.bytes, 0);
  tail.set(manifestSeg.bytes, xlsxSeg.bytes.length);
  tail.set(directory, xlsxSeg.bytes.length + manifestSeg.bytes.length);
  const tailPath = jobPartPath(state.jobId, state.parts.length);
  await deps.ports.putPart(tailPath, tail);
  state.parts.push({ path: tailPath, bytes: tail.length });
  state.offset += tail.length;

  state.artifact = {
    filename: outputFilename,
    xlsxFilename,
    totalBytes: state.offset,
    manifestFingerprint,
    imageCount,
  };
  state.summary = {
    mode: plan.mode,
    generatedAt: plan.startedAt,
    actor: plan.actor,
    outputFilename,
    xlsxFilename,
    productRowCount: packageRows.length,
    physicalRowCount: physicalRowCount(packageRows),
    productsWithOptions: survivorsWith.filter(({ product }) => product.row.hasOptions).length,
    optionCount: survivorsWith.reduce((acc, { product }) => acc + product.row.optionCount, 0),
    optionUpdateCount: plan.counts.optionUpdateCount,
    mappedIdCount: packageRows.length - newMarkerCount,
    newMarkerCount,
    needsReviewIncluded: survivorsWith.filter(({ product }) => product.row.needsOwnerReview).length,
    trueBlockersExcluded: plan.counts.trueBlockersExcluded,
    alreadySentExcluded: plan.counts.alreadySentExcluded,
    excludedNoImageCount: state.droppedNoImage.length,
    cappedExcludedCount: plan.counts.cappedExcludedCount,
    imageCount,
    manifestFingerprint,
    integrityOk: true,
  };
  state.items = items;
  state.status = "complete";

  // Durable history — ONCE per job, only now that every artifact byte is
  // committed. Recording failure never un-completes the artifact (mirrors the
  // pre-existing best-effort semantics) but is represented explicitly.
  if (deps.recordPackage && state.packageRecorded === null) {
    try {
      state.packageRecorded = await deps.recordPackage({
        mode: plan.mode,
        outputFilename,
        manifestFingerprint,
        productCount: packageRows.length,
        imageCount,
        generatedAt: plan.startedAt,
        actor: plan.actor,
        items,
      });
    } catch {
      state.packageRecorded = { persisted: false, packageId: null, itemsPersisted: 0, supersededCount: 0 };
    }
  }
  return state;
}
