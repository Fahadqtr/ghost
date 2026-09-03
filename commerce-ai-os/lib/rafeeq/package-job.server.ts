// RAFEEQ.PKGJOB — job orchestration adapter (SERVER-ONLY).
//
// Thin I/O shell around the PURE engine (lib/export/rafeeq/package-job):
//   • start   — idempotent: an already-running job for the mode is returned,
//               never duplicated (retry-safe; no duplicate package baselines);
//   • step    — claims the job with an optimistic step counter (two concurrent
//               drivers can never both advance it), loads plan+state from the
//               private storage bucket, runs ONE bounded engine step, persists;
//   • status  — bookkeeping row → DTO;
//   • download— ordered part list for the streaming route (never buffered).
//
// Durability model: Supabase Storage bucket `rafeeq-packages` holds
//   jobs/<id>/plan.json   (immutable per-job plan)
//   jobs/<id>/state.json  (small resumable state, rewritten per step)
//   jobs/<id>/part-NNNNN  (ZIP segments; concat in order = the artifact)
// and table `rafeeq_package_jobs` holds the queryable bookkeeping row. An
// unmigrated table/bucket degrades to "jobs_unavailable" (42P01 pattern) —
// never a fabricated state. The durable package-history record is written by
// the engine's finalize step EXACTLY ONCE per job via recordRafeeqPackage.
// No catalog/ECL writes; nothing is marked sent; no Rafeeq API publish.

import "server-only";

import { randomUUID } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { safeImageUrlOrNull, safeFetchImage } from "@/lib/net/safeImage";
import { sniffImageExtension, mimeToExt } from "@/lib/export/package-core";
import { PACKAGE_LIMITS } from "@/lib/export/rafeeq/package";
import { loadRafeeqPreview } from "@/lib/export/rafeeq/preview.server";
import { loadRafeeqDeliveryState, recordRafeeqPackage } from "@/lib/rafeeq/fullsync.server";
import type { RafeeqFullSyncMode } from "@/lib/export/rafeeq/fullsync";
import {
  createRafeeqPackageJob,
  advanceRafeeqPackageJob,
  jobProgress,
  type RafeeqPackageJobPlan,
  type RafeeqPackageJobState,
} from "@/lib/export/rafeeq/package-job";
import {
  selectDownloadCandidates,
  selectHistoryCandidates,
  type RafeeqJobRowCandidate,
} from "@/lib/export/rafeeq/artifact-selection";
import { hasSentBaseline } from "@/lib/export/rafeeq/fullsync";
import {
  buildRafeeqEmailDraft,
  type RafeeqEmailDraft,
  type RafeeqEmailOptionExample,
} from "@/lib/export/rafeeq/email-draft";
import type { RafeeqJobUiErrorCode } from "@/lib/export/rafeeq/package-job-errors";

export const RAFEEQ_JOB_BUCKET = "rafeeq-packages";
const UNDEFINED_TABLE = "42P01";
/** a running job with no step progress for this long is considered abandoned
 *  and a new start may replace it (the old artifacts stay addressable). */
const STALE_MS = 30 * 60 * 1000;

export interface RafeeqJobStatusDTO {
  jobId: string;
  mode: RafeeqFullSyncMode;
  status: "running" | "complete" | "failed";
  phase: "images" | "finalize" | "done" | "failed";
  productsDone: number;
  productsTotal: number;
  imagesDone: number;
  bytesDone: number;
  artifact: { filename: string; totalBytes: number; manifestFingerprint: string; imageCount: number } | null;
  packageRecorded: boolean;
  packageId: string | null;
  error: { code: string; refId: string } | null;
}

export type RafeeqJobApiResult<T> = { ok: true; value: T } | { ok: false; error: RafeeqJobUiErrorCode; status: number };

const errResult = <T,>(error: RafeeqJobUiErrorCode, status: number): RafeeqJobApiResult<T> => ({ ok: false, error, status });

// ── storage helpers ───────────────────────────────────────────────────────────

async function putObject(path: string, bytes: Uint8Array, contentType: string): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.storage.from(RAFEEQ_JOB_BUCKET).upload(path, bytes, { contentType, upsert: true });
  if (error) throw new Error(`storage upload failed: ${path}`);
}

async function getObject(path: string): Promise<Uint8Array | null> {
  const admin = createAdminClient();
  const { data, error } = await admin.storage.from(RAFEEQ_JOB_BUCKET).download(path);
  if (error || !data) return null;
  return new Uint8Array(await data.arrayBuffer());
}

const json = (v: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(v));

async function getJson<T>(path: string): Promise<T | null> {
  const bytes = await getObject(path);
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return null;
  }
}

const planPath = (jobId: string) => `jobs/${jobId}/plan.json`;
const statePath = (jobId: string) => `jobs/${jobId}/state.json`;

// ── engine ports (real) ───────────────────────────────────────────────────────

async function fetchValidatedImage(sourceUrl: string): Promise<{ bytes: Uint8Array; ext: string } | null> {
  const safe = safeImageUrlOrNull(sourceUrl);
  if (!safe) return null;
  let res: Response;
  try {
    res = await safeFetchImage(safe);
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let buf: ArrayBuffer;
  try {
    buf = await res.arrayBuffer();
  } catch {
    return null;
  }
  const bytes = new Uint8Array(buf);
  if (bytes.length === 0 || bytes.length > PACKAGE_LIMITS.maxImageBytes) return null;
  const ext = sniffImageExtension(bytes) ?? mimeToExt(res.headers.get("content-type"));
  if (!ext) return null;
  return { bytes, ext };
}

const enginePorts = {
  fetchImage: fetchValidatedImage,
  putPart: (path: string, bytes: Uint8Array) => putObject(path, bytes, "application/octet-stream"),
};

// ── bookkeeping row ───────────────────────────────────────────────────────────

interface JobRow {
  id: string;
  mode: string;
  status: string;
  step: number;
  updated_at: string;
}

function rowSelect() {
  return "id, mode, status, step, updated_at";
}

function statusDTO(state: RafeeqPackageJobState, plan: Pick<RafeeqPackageJobPlan, "products">, mode: RafeeqFullSyncMode): RafeeqJobStatusDTO {
  const p = jobProgress(state, plan);
  return {
    jobId: state.jobId,
    mode,
    status: state.status,
    phase: p.phase,
    productsDone: p.productsDone,
    productsTotal: p.productsTotal,
    imagesDone: p.imagesDone,
    bytesDone: p.bytesDone,
    artifact: state.artifact
      ? {
          filename: state.artifact.filename,
          totalBytes: state.artifact.totalBytes,
          manifestFingerprint: state.artifact.manifestFingerprint,
          imageCount: state.artifact.imageCount,
        }
      : null,
    packageRecorded: state.packageRecorded?.persisted === true,
    packageId: state.packageRecorded?.packageId ?? null,
    error: state.error,
  };
}

// ── API surface ───────────────────────────────────────────────────────────────

/**
 * Start (or resume) the package job for a mode. Idempotent: a live running job
 * for the same mode is returned as-is so retries and double-clicks can never
 * fan out duplicate generations or duplicate history baselines.
 */
export async function startRafeeqPackageJob(input: { mode: RafeeqFullSyncMode; actor: string | null }): Promise<RafeeqJobApiResult<RafeeqJobStatusDTO>> {
  const admin = createAdminClient();

  const existing = await admin
    .from("rafeeq_package_jobs")
    .select(rowSelect())
    .eq("mode", input.mode)
    .eq("status", "running")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing.error && String((existing.error as { code?: string }).code ?? "") === UNDEFINED_TABLE) {
    return errResult("jobs_unavailable", 503);
  }
  const live = existing.data as unknown as JobRow | null;
  if (live && Date.now() - new Date(live.updated_at).getTime() < STALE_MS) {
    const st = await getJson<RafeeqPackageJobState>(statePath(live.id));
    const plan = await getJson<RafeeqPackageJobPlan>(planPath(live.id));
    if (st && plan) return { ok: true, value: statusDTO(st, plan, input.mode) };
  }

  const preview = await loadRafeeqPreview();
  if (!preview) return errResult("generation_failed", 503);
  const delivery = await loadRafeeqDeliveryState();
  if (input.mode === "NEW" && delivery.availability === "UNAVAILABLE") {
    // the NEW package is DEFINED by the sent baseline — refuse, never guess.
    return errResult("jobs_unavailable", 503);
  }

  const jobId = randomUUID();
  const created = createRafeeqPackageJob({
    jobId,
    mode: input.mode,
    previewRows: preview.rows,
    sentBaseline: delivery.sentBaseline,
    actor: input.actor,
    nowIso: new Date().toISOString(),
  });
  if (!created.ok) return errResult("no_exportable_rows", 422);

  const inserted = await admin
    .from("rafeeq_package_jobs")
    .insert({ id: jobId, mode: input.mode, status: "running", step: 0, created_by: input.actor })
    .select("id")
    .maybeSingle();
  if (inserted.error) {
    return errResult(String((inserted.error as { code?: string }).code ?? "") === UNDEFINED_TABLE ? "jobs_unavailable" : "generation_failed", 503);
  }
  await putObject(planPath(jobId), json(created.plan), "application/json");
  await putObject(statePath(jobId), json(created.state), "application/json");
  return { ok: true, value: statusDTO(created.state, created.plan, input.mode) };
}

/** Read a job's current status (no side effects). */
export async function getRafeeqPackageJob(jobId: string): Promise<RafeeqJobApiResult<RafeeqJobStatusDTO>> {
  const admin = createAdminClient();
  const row = await admin.from("rafeeq_package_jobs").select(rowSelect()).eq("id", jobId).maybeSingle();
  if (row.error) {
    return errResult(String((row.error as { code?: string }).code ?? "") === UNDEFINED_TABLE ? "jobs_unavailable" : "job_not_found", 503);
  }
  if (!row.data) return errResult("job_not_found", 404);
  const state = await getJson<RafeeqPackageJobState>(statePath(jobId));
  const plan = await getJson<RafeeqPackageJobPlan>(planPath(jobId));
  if (!state || !plan) return errResult("job_not_found", 404);
  return { ok: true, value: statusDTO(state, plan, (row.data as unknown as JobRow).mode as RafeeqFullSyncMode) };
}

/**
 * Drive the job forward by ONE bounded step. Concurrency-safe: the step is
 * claimed with an optimistic `step` counter update; a competing driver loses
 * the claim and simply receives the current status ("conflict" only when the
 * row cannot be read at all).
 */
export async function stepRafeeqPackageJob(jobId: string): Promise<RafeeqJobApiResult<RafeeqJobStatusDTO>> {
  const admin = createAdminClient();
  const row = await admin.from("rafeeq_package_jobs").select(rowSelect()).eq("id", jobId).maybeSingle();
  if (row.error) {
    return errResult(String((row.error as { code?: string }).code ?? "") === UNDEFINED_TABLE ? "jobs_unavailable" : "job_not_found", 503);
  }
  if (!row.data) return errResult("job_not_found", 404);
  const seen = row.data as unknown as JobRow;

  const state = await getJson<RafeeqPackageJobState>(statePath(jobId));
  const plan = await getJson<RafeeqPackageJobPlan>(planPath(jobId));
  if (!state || !plan) return errResult("job_not_found", 404);
  if (state.status !== "running") return { ok: true, value: statusDTO(state, plan, seen.mode as RafeeqFullSyncMode) };

  // optimistic claim — exactly one driver advances a given step index.
  const claim = await admin
    .from("rafeeq_package_jobs")
    .update({ step: seen.step + 1, updated_at: new Date().toISOString() })
    .eq("id", jobId)
    .eq("step", seen.step)
    .select("id");
  if (claim.error || !Array.isArray(claim.data) || claim.data.length === 0) {
    return { ok: true, value: statusDTO(state, plan, seen.mode as RafeeqFullSyncMode) };
  }

  const next = await advanceRafeeqPackageJob(state, plan, {
    ports: enginePorts,
    recordPackage: async (input) => {
      const r = await recordRafeeqPackage(input);
      return { persisted: r.persisted, packageId: r.packageId, itemsPersisted: r.itemsPersisted, supersededCount: r.supersededCount };
    },
  });

  await putObject(statePath(jobId), json(next), "application/json");
  const progress = jobProgress(next, plan);
  await admin
    .from("rafeeq_package_jobs")
    .update({
      status: next.status,
      products_done: progress.productsDone,
      products_total: progress.productsTotal,
      images_done: progress.imagesDone,
      bytes_done: progress.bytesDone,
      artifact_filename: next.artifact?.filename ?? null,
      artifact_bytes: next.artifact?.totalBytes ?? null,
      manifest_fingerprint: next.artifact?.manifestFingerprint ?? null,
      package_id: next.packageRecorded?.packageId ?? null,
      error_code: next.error?.code ?? null,
      error_ref: next.error?.refId ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", jobId);

  return { ok: true, value: statusDTO(next, plan, seen.mode as RafeeqFullSyncMode) };
}

/** The ordered artifact parts for streaming download (complete jobs only). */
export async function getRafeeqPackageArtifact(jobId: string): Promise<
  RafeeqJobApiResult<{ filename: string; totalBytes: number; parts: { path: string; bytes: number }[] }>
> {
  const state = await getJson<RafeeqPackageJobState>(statePath(jobId));
  if (!state) return errResult("job_not_found", 404);
  if (state.status !== "complete" || !state.artifact) return errResult("job_not_found", 409);
  return { ok: true, value: { filename: state.artifact.filename, totalBytes: state.artifact.totalBytes, parts: state.parts } };
}

/** Download one artifact part (streamed by the route, one part in memory at a time). */
export async function readRafeeqPackagePart(path: string): Promise<Uint8Array | null> {
  return getObject(path);
}

// ── DOWNLOAD LAST COMPLETED PACKAGE (READ-ONLY — never creates a job, never
//    regenerates, never touches package history / sent state) ─────────────────

export interface RafeeqCompletedArtifactDTO {
  jobId: string;
  mode: RafeeqFullSyncMode;
  filename: string;
  totalBytes: number;
  generatedAt: string;
  productCount: number;
  imageCount: number;
  packageId: string | null;
  sentAt: string | null;
}

const CANDIDATE_SELECT =
  "id, mode, status, created_at, products_total, images_done, artifact_filename, artifact_bytes, package_id";

function toCandidate(r: Record<string, unknown>): RafeeqJobRowCandidate {
  return {
    id: String(r.id ?? ""),
    mode: String(r.mode ?? ""),
    status: String(r.status ?? ""),
    createdAt: String(r.created_at ?? ""),
    artifactFilename: typeof r.artifact_filename === "string" && r.artifact_filename !== "" ? r.artifact_filename : null,
    artifactBytes: typeof r.artifact_bytes === "number" ? r.artifact_bytes : r.artifact_bytes ? Number(r.artifact_bytes) : null,
    productsTotal: Number(r.products_total ?? 0),
    imagesDone: Number(r.images_done ?? 0),
    packageId: typeof r.package_id === "string" && r.package_id !== "" ? r.package_id : null,
  };
}

async function readCandidates(): Promise<RafeeqJobRowCandidate[] | null> {
  const admin = createAdminClient();
  const res = await admin
    .from("rafeeq_package_jobs")
    .select(CANDIDATE_SELECT)
    .eq("status", "complete")
    .order("created_at", { ascending: false })
    .limit(50);
  if (res.error) return null; // unmigrated/read error → no downloadable artifacts, never fabricated
  return ((res.data ?? []) as Record<string, unknown>[]).map(toCandidate);
}

/** true when every recorded artifact part still exists in the storage bucket. */
async function artifactPartsExist(jobId: string, parts: readonly { path: string }[]): Promise<boolean> {
  if (parts.length === 0) return false;
  const admin = createAdminClient();
  const { data, error } = await admin.storage.from(RAFEEQ_JOB_BUCKET).list(`jobs/${jobId}`, { limit: 1000 });
  if (error || !data) return false;
  const names = new Set(data.map((o: { name: string }) => o.name));
  return parts.every((p) => names.has(p.path.split("/").pop() ?? ""));
}

async function sentAtByPackageIds(ids: readonly string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (ids.length === 0) return out;
  const admin = createAdminClient();
  const res = await admin.from("rafeeq_packages").select("id, sent_at").in("id", ids as string[]);
  if (!res.error && Array.isArray(res.data)) {
    for (const r of res.data as { id: string; sent_at: string | null }[]) out.set(String(r.id), r.sent_at ?? null);
  }
  return out;
}

function toArtifactDTO(c: RafeeqJobRowCandidate, state: RafeeqPackageJobState, sentAt: string | null): RafeeqCompletedArtifactDTO {
  return {
    jobId: c.id,
    mode: c.mode as RafeeqFullSyncMode,
    filename: state.artifact?.filename ?? c.artifactFilename ?? "",
    totalBytes: state.artifact?.totalBytes ?? c.artifactBytes ?? 0,
    generatedAt: c.createdAt,
    productCount: state.summary?.productRowCount ?? c.productsTotal,
    imageCount: state.artifact?.imageCount ?? c.imagesDone,
    packageId: c.packageId,
    sentAt,
  };
}

/**
 * The latest COMPLETE, storage-verified artifact for a mode (or null). Walks
 * the ordered candidates so a newest row whose files were removed falls back
 * to the next valid one. READ-ONLY.
 */
export async function getLatestCompletedRafeeqArtifact(mode: RafeeqFullSyncMode): Promise<RafeeqCompletedArtifactDTO | null> {
  const rows = await readCandidates();
  if (!rows) return null;
  for (const c of selectDownloadCandidates(rows, mode).slice(0, 5)) {
    const state = await getJson<RafeeqPackageJobState>(statePath(c.id));
    if (!state || state.status !== "complete" || !state.artifact) continue;
    if (!(await artifactPartsExist(c.id, state.parts))) continue;
    const sent = await sentAtByPackageIds(c.packageId ? [c.packageId] : []);
    return toArtifactDTO(c, state, c.packageId ? (sent.get(c.packageId) ?? null) : null);
  }
  return null;
}

/** Recent downloadable artifacts across both modes (history section). READ-ONLY. */
export async function listRecentCompletedRafeeqArtifacts(limit = 10): Promise<RafeeqCompletedArtifactDTO[]> {
  const rows = await readCandidates();
  if (!rows) return [];
  const picked = selectHistoryCandidates(rows, limit);
  const sent = await sentAtByPackageIds(picked.map((c) => c.packageId).filter((v): v is string => v !== null));
  const out: RafeeqCompletedArtifactDTO[] = [];
  for (const c of picked) {
    const state = await getJson<RafeeqPackageJobState>(statePath(c.id));
    if (!state || state.status !== "complete" || !state.artifact) continue;
    out.push(toArtifactDTO(c, state, c.packageId ? (sent.get(c.packageId) ?? null) : null));
  }
  return out;
}

// ── RAFEEQ EMAIL DRAFT (READ-ONLY — never sends, never mutates history) ──────

/** Real representative option examples picked from THIS package's plan. */
function pickEmailExamples(plan: RafeeqPackageJobPlan): {
  samePrice: RafeeqEmailOptionExample | null;
  differing: RafeeqEmailOptionExample | null;
} {
  let samePrice: RafeeqEmailOptionExample | null = null;
  let differing: RafeeqEmailOptionExample | null = null;
  for (const { row } of plan.products) {
    if (!row.hasOptions || row.options.length === 0) continue;
    if (!row.priceOnSelection && samePrice === null) {
      samePrice = {
        parentSku: row.sku,
        title: row.title,
        options: row.options.slice(0, 5).map((o) => ({ name: o.nameEn || o.nameAr, price: row.price })),
      };
    }
    if (row.priceOnSelection && differing === null) {
      differing = {
        parentSku: row.sku,
        title: row.title,
        options: row.options.slice(0, 5).map((o) => ({ name: o.nameEn || o.nameAr, price: o.effectivePrice ?? null })),
      };
    }
    if (samePrice && differing) break;
  }
  return { samePrice, differing };
}

/**
 * Build the ready-to-use Rafeeq email draft for a COMPLETED job — from the
 * actual state/plan metadata (counts and examples are never hardcoded).
 * READ-ONLY: nothing is sent, package history and sent state are untouched.
 */
export async function buildRafeeqEmailDraftForJob(
  jobId: string,
  opts?: { downloadLink?: { url: string; expiresAtIso: string; filename?: string | null } | null },
): Promise<RafeeqJobApiResult<RafeeqEmailDraft>> {
  const admin = createAdminClient();
  const row = await admin.from("rafeeq_package_jobs").select(CANDIDATE_SELECT).eq("id", jobId).maybeSingle();
  if (row.error) {
    return errResult(String((row.error as { code?: string }).code ?? "") === UNDEFINED_TABLE ? "jobs_unavailable" : "job_not_found", 503);
  }
  if (!row.data) return errResult("job_not_found", 404);
  const c = toCandidate(row.data as Record<string, unknown>);
  const state = await getJson<RafeeqPackageJobState>(statePath(jobId));
  const plan = await getJson<RafeeqPackageJobPlan>(planPath(jobId));
  if (!state || !plan || state.status !== "complete" || !state.artifact || !state.summary) {
    return errResult("job_not_found", 409);
  }

  // CORRECTION context: this recording superseded earlier package(s). We only
  // record THAT it supersedes — never which filename, because several builds
  // legitimately share one filename and a name cannot identify a build. The
  // email points Rafeeq at the secure link + this package's fingerprint.
  const correction = (state.packageRecorded?.supersededCount ?? 0) > 0;

  const delivery = await loadRafeeqDeliveryState();
  const baseline = hasSentBaseline(delivery.packages);
  const { samePrice, differing } = pickEmailExamples(plan);
  const s = state.summary;

  const draft = buildRafeeqEmailDraft({
    mode: c.mode === "NEW" ? "NEW" : "FULL",
    filename: state.artifact.filename,
    generatedAt: c.createdAt,
    productCount: s.productRowCount,
    physicalRowCount: s.physicalRowCount,
    productsWithOptions: s.productsWithOptions,
    optionCount: s.optionCount,
    imageCount: s.imageCount,
    warningCount: s.needsReviewIncluded,
    zipBytes: state.artifact.totalBytes,
    packageFingerprint: state.artifact.manifestFingerprint ?? null,
    correction,
    newPackage: c.mode === "NEW" ? { hasSentBaseline: baseline, equalsWholeCatalog: !baseline } : null,
    samePriceExample: samePrice,
    differingPriceExample: differing,
    downloadLink: opts?.downloadLink ?? null,
    // real clock, so an expired signed link is rejected rather than rendered
    nowIso: new Date().toISOString(),
  });
  return { ok: true, value: draft };
}
