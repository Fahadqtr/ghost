// TALABAT.PKGJOB — server layer for the chunked package job (SERVER-ONLY). STEP 74.
//
// Owns every effect the pure engine refuses to perform: it loads the certified
// preview, persists the plan/state to a private storage bucket, runs ONE
// bounded engine step per request, and keeps the `talabat_package_jobs` row in
// sync for the progress UI.
//
// Durability model: Supabase Storage bucket `talabat-packages` holds
// jobs/<id>/plan.json, jobs/<id>/state.json and the artifact parts
// (part-00000, part-00001, …). The DB row exists for queryability, idempotent
// start and the optimistic step claim. An unmigrated table/bucket degrades to
// "jobs_unavailable" (42P01) rather than throwing.
//
// SAFETY: package CONTENT is unchanged — master scope, pricing (STEP 72),
// barcode alias (STEP 68) and category resolution (STEP 64) all happen upstream
// in loadTalabatPreview and are consumed verbatim. The only durable writes are
// the job row, the storage objects, the ONE mapping sync and the ONE audit row
// — exactly the writes the single-shot route already performed. No marketplace
// call, no email, nothing marked as sent.

import "server-only";

import { randomUUID } from "node:crypto";

import { createAdminClient } from "@/lib/supabase/admin";
import { insertAuditRow } from "@/lib/audit";
import { safeImageUrlOrNull, safeFetchImage } from "@/lib/net/safeImage";
import { loadTalabatPreview } from "@/lib/export/talabat/preview.server";
import { syncTalabatMappingsFromCatalog } from "@/lib/talabat/mapping-sync/catalog-sync.server";
import {
  sniffImageExtension,
  mimeToExt,
  TALABAT_PACKAGE_LIMITS,
  type TalabatGenerationMode,
} from "@/lib/export/talabat/package";
import type { TalabatPreviewRow } from "@/lib/export/talabat/preview";
import {
  createTalabatPackageJob,
  advanceTalabatPackageJob,
  jobProgress,
  type TalabatPackageJobPlan,
  type TalabatPackageJobState,
  type TalabatPackageJobSummary,
  type TalabatJobPorts,
} from "@/lib/export/talabat/package-job";
import type { TalabatJobStage, TalabatJobUiErrorCode } from "@/lib/export/talabat/package-job-errors";
import { isRecoverableTalabatJobError } from "@/lib/export/talabat/package-job-errors";
import { mappingComplete, normalizeTalabatPackageJobState } from "@/lib/export/talabat/package-job";
import {
  DELTA_IMAGE_ZIP_PATH, DELTA_IMAGE_META_PATH, auditDeltaImageCoverage, parseDeltaImageMeta,
  type DeltaImageMeta, type DeltaImageCoverage,
} from "@/lib/export/talabat/delta-image-package";
import { streamPartsToObject } from "@/lib/export/artifact-stream";
import { makeTusPorts } from "@/lib/storage/tus.server";

const BUCKET = "talabat-packages";
const CHANNEL = "talabat:malikas";
const DESTINATION = "talabat:malikas";
const UNDEFINED_TABLE = "42P01";
/** Postgres unique_violation — the partial one-active-job index rejected us. */
const UNIQUE_VIOLATION = "23505";
/** Internal marker for a job abandoned mid-flight and reaped by a later start. */
const STALE_ERROR_CODE = "stale_abandoned";
/** Only a real UUID may ever become a storage prefix (defense in depth). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A running job untouched for longer than this is treated as abandoned. */
const STALE_MS = 10 * 60 * 1000;

interface JobRow {
  id: string;
  mode: string;
  status: "queued" | "running" | "completed" | "failed";
  stage: TalabatJobStage;
  step: number;
  error_code: string | null;
  created_by: string | null;
  started_at: string;
  updated_at: string;
  completed_at: string | null;
}

const ROW_SELECT = "id, mode, status, stage, step, error_code, created_by, started_at, updated_at, completed_at";

export interface TalabatJobStatusDTO {
  jobId: string;
  channel: string;
  status: "queued" | "running" | "completed" | "failed";
  stage: TalabatJobStage;
  progressCurrent: number;
  progressTotal: number;
  progressPercent: number;
  rowsTotal: number;
  bytesDone: number;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  artifact: {
    filename: string;
    totalBytes: number;
    sha256: string | null;
    manifestFingerprint: string;
    imageCount: number;
    rowCount: number;
    productCount: number;
  } | null;
  mappingsSynced: boolean;
  auditRecorded: boolean;
  error: { code: string; refId: string } | null;
  /** STEP 76 — every planned image is packaged and the archive is durable. */
  imagesComplete: boolean;
  /** STEP 76 — a failure here can resume in place; images are NOT re-fetched. */
  resumable: boolean;
}

export type TalabatJobApiResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: TalabatJobUiErrorCode; status: number };

const errResult = <T,>(error: TalabatJobUiErrorCode, status: number): TalabatJobApiResult<T> => ({ ok: false, error, status });

// ── storage helpers ───────────────────────────────────────────────────────────

async function putObject(path: string, bytes: Uint8Array, contentType: string): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.storage.from(BUCKET).upload(path, bytes, { contentType, upsert: true });
  if (error) throw new Error(`storage upload failed: ${path}`);
}

async function getObject(path: string): Promise<Uint8Array | null> {
  const admin = createAdminClient();
  const { data, error } = await admin.storage.from(BUCKET).download(path);
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

/**
 * STEP 77 — the ONE way job state is read back.
 *
 * Persisted state is plain JSON from whichever build wrote it, so a state
 * written before a field existed reads that field as `undefined`. Normalising
 * here — at the single read boundary rather than at each use — means every
 * consumer downstream is handed real numbers and no comparison can ever meet an
 * `undefined`. Every state read goes through this; none calls getJson directly.
 */
async function readState(jobId: string): Promise<TalabatPackageJobState | null> {
  return normalizeTalabatPackageJobState(await getJson<unknown>(statePath(jobId)));
}
/** The ONE deterministic storage prefix owned by a job. */
export const jobPrefix = (jobId: string) => `jobs/${jobId}`;

/**
 * STEP 75 — delete the temporary artifacts of a TERMINAL job.
 *
 * Scope is exactly `talabat-packages/jobs/<uuid>/` and, within it, only the ZIP
 * parts plus the (now useless) plan. state.json is KEPT: it is small and is the
 * diagnostic record of why the job failed.
 *
 * Never call this for a completed job — a completed artifact IS its parts.
 * The jobId is UUID-validated before it is used as a prefix, so a malformed id
 * can never widen the deletion, and `remove()` is given an explicit list of
 * exact paths (never a bucket-wide or prefix-wide delete).
 *
 * Failure here is swallowed: a cleanup problem must never overwrite or mask the
 * original job failure, and never reaches the UI.
 */
async function cleanupJobArtifacts(jobId: string): Promise<{ ok: boolean; removed: number }> {
  if (!UUID_RE.test(jobId)) return { ok: false, removed: 0 };
  try {
    const admin = createAdminClient();
    const prefix = jobPrefix(jobId);
    const { data, error } = await admin.storage.from(BUCKET).list(prefix, { limit: 1000 });
    if (error || !Array.isArray(data)) return { ok: false, removed: 0 };
    // ONLY this job's parts and its plan — never state.json, never anything
    // outside this prefix.
    const doomed = data
      .map((o) => String((o as { name?: unknown }).name ?? ""))
      .filter((name) => name.startsWith("part-") || name === "plan.json")
      .map((name) => `${prefix}/${name}`);
    if (doomed.length === 0) return { ok: true, removed: 0 };
    const res = await admin.storage.from(BUCKET).remove(doomed);
    if (res.error) return { ok: false, removed: 0 };
    return { ok: true, removed: doomed.length };
  } catch {
    return { ok: false, removed: 0 };
  }
}

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
  if (bytes.length === 0 || bytes.length > TALABAT_PACKAGE_LIMITS.maxImageBytes) return null;
  const ext = sniffImageExtension(bytes) ?? mimeToExt(res.headers.get("content-type"));
  if (!ext) return null;
  return { bytes, ext };
}

const enginePorts: TalabatJobPorts = {
  fetchImage: fetchValidatedImage,
  putPart: (path, bytes) => putObject(path, bytes, "application/octet-stream"),
};

/** The ONE audit-trail row — identical shape to the single-shot generator's. */
async function recordAudit(summary: TalabatPackageJobSummary): Promise<boolean> {
  try {
    const admin = createAdminClient();
    const res = await insertAuditRow(admin, {
      agent: "malak",
      action: null,
      field: "export_package",
      details: {
        mode: summary.destination,
        actor: summary.actor,
        status: "done",
        destination: DESTINATION,
        output_filename: summary.outputFilename,
        sellable_row_count: summary.sellableRowCount,
        product_count: summary.productCount,
        image_count: summary.imageCount,
        warning_count: summary.warningCount,
        excluded_blocked_count: summary.excludedBlockedCount,
        excluded_no_image_count: summary.excludedNoImageCount,
        manifest_fingerprint: summary.manifestFingerprint,
        started_at: summary.generatedAt,
        finished_at: new Date().toISOString(),
      },
      status: "done",
    });
    return !res.error;
  } catch {
    return false;
  }
}

// ── DTO ───────────────────────────────────────────────────────────────────────

function statusDTO(state: TalabatPackageJobState, plan: TalabatPackageJobPlan, row: JobRow | null): TalabatJobStatusDTO {
  const p = jobProgress(state, plan);
  return {
    jobId: state.jobId,
    channel: CHANNEL,
    status: state.status === "running" ? "running" : state.status,
    stage: p.stage,
    progressCurrent: p.progressCurrent,
    progressTotal: p.progressTotal,
    progressPercent: p.progressPercent,
    rowsTotal: p.rowsTotal,
    bytesDone: p.bytesDone,
    startedAt: row?.started_at ?? plan.startedAt,
    updatedAt: row?.updated_at ?? plan.startedAt,
    completedAt: row?.completed_at ?? null,
    artifact: state.artifact && state.summary
      ? {
        filename: state.artifact.filename,
        totalBytes: state.artifact.totalBytes,
        sha256: state.artifact.sha256,
        manifestFingerprint: state.artifact.manifestFingerprint,
        imageCount: state.artifact.imageCount,
        rowCount: state.summary.sellableRowCount,
        productCount: state.summary.productCount,
      }
      : null,
    mappingsSynced: mappingComplete(state),
    auditRecorded: state.auditRecorded,
    error: state.error,
    imagesComplete: state.artifact !== null,
    // Resumable when the archive is already durable: the remaining work is the
    // cheap finalization tail, so a retry continues instead of restarting.
    resumable: state.artifact !== null && state.status !== "completed",
  };
}

// ── public API ────────────────────────────────────────────────────────────────

/** STEP 76 — keep a resumed job out of the stale window while it is driven. */
async function touchJob(jobId: string): Promise<void> {
  try {
    const admin = createAdminClient();
    await admin
      .from("talabat_package_jobs")
      .update({ status: "running", error_code: null, error_ref: null, updated_at: new Date().toISOString() })
      .eq("id", jobId);
  } catch {
    /* best-effort: resuming still works, the row just keeps its old timestamp */
  }
}

/**
 * STEP 76 — revive a job that FAILED recoverably (upload_incomplete): its
 * artifact and every part are still durable, so the operator continues the
 * finalization tail on the SAME job instead of re-downloading 2501 images.
 * Safe against the partial unique index because it only runs when no other
 * queued/running row exists for the channel.
 */
async function resumeRecoverableJob(): Promise<JobRow | null> {
  try {
    const admin = createAdminClient();
    const row = await admin
      .from("talabat_package_jobs").select(ROW_SELECT)
      .eq("channel", CHANNEL).eq("status", "failed")
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    const cand = row.data as unknown as JobRow | null;
    if (!cand || !isRecoverableTalabatJobError(cand.error_code)) return null;
    const revived = await admin
      .from("talabat_package_jobs")
      .update({ status: "running", error_code: null, error_ref: null, completed_at: null, updated_at: new Date().toISOString() })
      .eq("id", cand.id).eq("status", "failed")
      .select(ROW_SELECT).maybeSingle();
    return (revived.data as unknown as JobRow | null) ?? null;
  } catch {
    return null;
  }
}

/**
 * STEP 75 — atomically retire an abandoned job and clean its temporary parts.
 *
 * The status guard makes the transition the arbitration point: only the racer
 * whose UPDATE matches a still-active row performs the cleanup, so parts are
 * never deleted twice and never while another worker still owns the job.
 */
async function reapStaleJob(jobId: string): Promise<boolean> {
  const admin = createAdminClient();
  const nowIso = new Date().toISOString();
  const claimed = await admin
    .from("talabat_package_jobs")
    .update({
      status: "failed",
      error_code: STALE_ERROR_CODE,
      error_ref: `${jobId.slice(0, 8)}-stale`,
      completed_at: nowIso,
      updated_at: nowIso,
    })
    .eq("id", jobId)
    .in("status", ["queued", "running"])
    .select("id");
  const won = !claimed.error && Array.isArray(claimed.data) && claimed.data.length > 0;
  // Cleanup is best-effort and never masks anything: the row is already retired.
  if (won) await cleanupJobArtifacts(jobId);
  return won;
}

/**
 * Start (or RESUME) the Talabat package job. Idempotent by design: a live job
 * for the channel is returned instead of starting a second one, so a
 * double-click can never create competing jobs.
 *
 * This call performs NO image work — it loads the preview, writes the plan and
 * returns. That is what removes FUNCTION_INVOCATION_TIMEOUT from the start path.
 */
export async function startTalabatPackageJob(input: {
  mode: TalabatGenerationMode;
  selectedKeys?: readonly string[];
  actor: string | null;
}): Promise<TalabatJobApiResult<TalabatJobStatusDTO>> {
  const admin = createAdminClient();

  const existing = await admin
    .from("talabat_package_jobs")
    .select(ROW_SELECT)
    .eq("channel", CHANNEL)
    .in("status", ["queued", "running"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing.error && String((existing.error as { code?: string }).code ?? "") === UNDEFINED_TABLE) {
    return errResult("jobs_unavailable", 503);
  }
  const live = existing.data as unknown as JobRow | null;
  if (live) {
    const fresh = Date.now() - new Date(live.updated_at).getTime() < STALE_MS;
    const st0 = await readState(live.id);
    const pl0 = await getJson<TalabatPackageJobPlan>(planPath(live.id));
    // STEP 76 — a job whose ARTIFACT is already durable is resumable no matter
    // how long it has been idle. The first production run reached 2501/2501 and
    // committed a valid 538 MB archive, then stalled in the finalization tail;
    // reaping it as "stale" destroyed all 66 parts and forced a full restart.
    // Durable work is never thrown away again: such a job is resumed in place,
    // keeping its id, its parts and its image cursor.
    const hasDurableArtifact = st0?.artifact != null && st0.status !== "completed";
    if (fresh || hasDurableArtifact) {
      if (st0 && pl0) {
        if (!fresh && hasDurableArtifact) await touchJob(live.id);
        return { ok: true, value: statusDTO(st0, pl0, live) };
      }
    }
    if (!fresh && !hasDurableArtifact) {
      // STEP 75 — STALE. It is not enough to ignore the row: leaving it
      // queued/running forever would both leak its parts and (with the partial
      // unique index) permanently block every replacement. Transition it out of
      // the active set ATOMICALLY, then clean its temporary parts. The `.in`
      // guard means exactly one racer wins the reap; the loser's update matches
      // no row and it proceeds to the insert, where the unique index arbitrates.
      await reapStaleJob(live.id);
    }
  }

  // STEP 76 — before starting anything new, revive a recoverably-failed job:
  // its artifact and parts are durable, so "retry" must continue that job
  // rather than re-downloading 2501 images into a fresh one.
  const revived = await resumeRecoverableJob();
  if (revived) {
    const st = await readState(revived.id);
    const pl = await getJson<TalabatPackageJobPlan>(planPath(revived.id));
    if (st && pl) return { ok: true, value: statusDTO(st, pl, revived) };
  }

  const preview = await loadTalabatPreview();
  if (!preview) return errResult("generation_failed", 503);

  const jobId = randomUUID();
  const created = createTalabatPackageJob({
    jobId,
    mode: input.mode,
    selectedKeys: input.selectedKeys,
    previewRows: preview.rows,
    actor: input.actor,
    nowIso: new Date().toISOString(),
  });
  if (!created.ok) return errResult("no_exportable_rows", 422);

  const progress = jobProgress(created.state, created.plan);
  const inserted = await admin
    .from("talabat_package_jobs")
    .insert({
      id: jobId, channel: CHANNEL, mode: input.mode, status: "running",
      stage: created.state.stage, step: 0,
      progress_current: 0, progress_total: progress.progressTotal,
      rows_total: progress.rowsTotal, products_total: created.plan.counts.simpleProductCount + created.plan.counts.variantRowCount,
      created_by: input.actor,
    })
    .select("id")
    .maybeSingle();
  if (inserted.error) {
    const pgCode = String((inserted.error as { code?: string }).code ?? "");
    if (pgCode === UNDEFINED_TABLE) return errResult("jobs_unavailable", 503);
    if (pgCode === UNIQUE_VIOLATION) {
      // STEP 75 — we LOST the race: another request created the active job
      // between our lookup and our insert. Serve that job instead of an error;
      // a raw DB error must never reach the operator.
      const winner = await admin
        .from("talabat_package_jobs").select(ROW_SELECT)
        .eq("channel", CHANNEL).in("status", ["queued", "running"])
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      const row = winner.data as unknown as JobRow | null;
      if (row) {
        const st = await readState(row.id);
        const pl = await getJson<TalabatPackageJobPlan>(planPath(row.id));
        if (st && pl) return { ok: true, value: statusDTO(st, pl, row) };
      }
      // The winner exists but has not published its plan/state yet — a friendly
      // "another generation is in progress", never the DB error.
      return errResult("conflict", 409);
    }
    return errResult("generation_failed", 503);
  }
  await putObject(planPath(jobId), json(created.plan), "application/json");
  await putObject(statePath(jobId), json(created.state), "application/json");
  return { ok: true, value: statusDTO(created.state, created.plan, null) };
}

/** Read a job's current status (no side effects) — this is what the UI polls. */
export async function getTalabatPackageJob(jobId: string): Promise<TalabatJobApiResult<TalabatJobStatusDTO>> {
  const admin = createAdminClient();
  const row = await admin.from("talabat_package_jobs").select(ROW_SELECT).eq("id", jobId).maybeSingle();
  if (row.error) {
    return errResult(String((row.error as { code?: string }).code ?? "") === UNDEFINED_TABLE ? "jobs_unavailable" : "job_not_found", 503);
  }
  if (!row.data) return errResult("job_not_found", 404);
  const state = await readState(jobId);
  const plan = await getJson<TalabatPackageJobPlan>(planPath(jobId));
  if (!state || !plan) return errResult("job_not_found", 404);
  return { ok: true, value: statusDTO(state, plan, row.data as unknown as JobRow) };
}

/**
 * Drive the job forward by ONE bounded step. Concurrency-safe: the step is
 * claimed with an optimistic `step` counter update, so a competing driver
 * loses the claim and simply receives the current status.
 */
export async function stepTalabatPackageJob(jobId: string): Promise<TalabatJobApiResult<TalabatJobStatusDTO>> {
  const admin = createAdminClient();
  const row = await admin.from("talabat_package_jobs").select(ROW_SELECT).eq("id", jobId).maybeSingle();
  if (row.error) {
    return errResult(String((row.error as { code?: string }).code ?? "") === UNDEFINED_TABLE ? "jobs_unavailable" : "job_not_found", 503);
  }
  if (!row.data) return errResult("job_not_found", 404);
  const seen = row.data as unknown as JobRow;

  const state = await readState(jobId);
  const plan = await getJson<TalabatPackageJobPlan>(planPath(jobId));
  if (!state || !plan) return errResult("job_not_found", 404);
  if (state.status !== "running") return { ok: true, value: statusDTO(state, plan, seen) };

  // optimistic claim — exactly one driver advances a given step index.
  const claim = await admin
    .from("talabat_package_jobs")
    .update({ step: seen.step + 1, updated_at: new Date().toISOString() })
    .eq("id", jobId)
    .eq("step", seen.step)
    .select("id");
  if (claim.error || !Array.isArray(claim.data) || claim.data.length === 0) {
    return { ok: true, value: statusDTO(state, plan, seen) };
  }

  const next = await advanceTalabatPackageJob(state, plan, {
    ports: enginePorts,
    syncMappings: async (actor, offset) => {
      const r = await syncTalabatMappingsFromCatalog(actor ?? "", offset);
      return {
        ok: r.ok,
        inserted: r.counts?.inserted ?? 0,
        updated: r.counts?.updated ?? 0,
        failed: r.counts?.failed ?? 0,
        totalCandidates: r.totalCandidates,
        nextOffset: r.nextOffset,
      };
    },
    recordAudit,
  });

  await putObject(statePath(jobId), json(next), "application/json");
  // STEP 75 — a job that just FAILED will never be resumed (retry starts a new
  // job), so its parts are dead weight: up to ~800 MB per failure. Clean them
  // now, scoped to this job's own prefix. Best-effort by construction — a
  // cleanup problem must not change the recorded failure.
  // STEP 76 — clean ONLY an UNRECOVERABLE failure. A recoverable one
  // (upload_incomplete: the artifact is durable, only the finalization tail
  // remains) keeps every part so the same job can resume without re-fetching
  // 2501 images. Deleting them is exactly what destroyed the first real 538 MB
  // artifact in production.
  if (next.status === "failed" && !isRecoverableTalabatJobError(next.error?.code)) {
    await cleanupJobArtifacts(jobId);
  }
  const progress = jobProgress(next, plan);
  const nowIso = new Date().toISOString();
  await admin
    .from("talabat_package_jobs")
    .update({
      status: next.status,
      stage: progress.stage,
      progress_current: progress.progressCurrent,
      progress_total: progress.progressTotal,
      rows_total: progress.rowsTotal,
      bytes_done: progress.bytesDone,
      artifact_filename: next.artifact?.filename ?? null,
      artifact_bytes: next.artifact?.totalBytes ?? null,
      artifact_sha256: next.artifact?.sha256 ?? null,
      manifest_fingerprint: next.artifact?.manifestFingerprint ?? null,
      audit_recorded: next.auditRecorded,
      mappings_synced: next.mappingSync?.ok === true,
      error_code: next.error?.code ?? null,
      error_ref: next.error?.refId ?? null,
      completed_at: next.status === "completed" ? nowIso : null,
      updated_at: nowIso,
    })
    .eq("id", jobId);

  const after = await admin.from("talabat_package_jobs").select(ROW_SELECT).eq("id", jobId).maybeSingle();
  return { ok: true, value: statusDTO(next, plan, (after.data as unknown as JobRow | null) ?? seen) };
}

/** The ordered artifact parts for a COMPLETED job (for streamed download). */
export async function getTalabatPackageArtifact(jobId: string): Promise<
  { ok: true; filename: string; totalBytes: number; parts: string[] } | { ok: false }
> {
  const state = await readState(jobId);
  if (!state || state.status !== "completed" || !state.artifact) return { ok: false };
  return {
    ok: true,
    filename: state.artifact.filename,
    totalBytes: state.artifact.totalBytes,
    parts: state.parts.map((p) => p.path),
  };
}

/** One artifact part's bytes (download streaming). */
export async function readTalabatPackagePart(path: string): Promise<Uint8Array | null> {
  return getObject(path);
}

// ── STEP 90: the Email B delta image package ─────────────────────────────────
//
// The SAME engine as above, driven over a subset of the same certified preview
// rows. Not a second image pipeline: same fetch port, same filename rules, same
// dedup, same retry, same §15 integrity check. Three deps differ, and each
// difference is deliberate:
//
//   imagesOnlyArchive        ON  — Email B attaches its own delta workbook; a
//                                  second, differently-built workbook inside
//                                  the linked ZIP is a wrong-import risk.
//   correctExtensionFromBytes ON — STEP 84 built this flag for exactly this
//                                  package (the certified full one keeps its
//                                  URL-derived names).
//   syncMappings / recordAudit OFF — staging images for an email is not a
//                                  catalogue export. No channel mapping is
//                                  written and no export audit row is created,
//                                  so this flow performs zero marketplace and
//                                  zero canonical writes.
//
// It runs on the SAME channel as the certified export, so the existing
// one-active-job index still guarantees only one image job at a time. No
// schema change: `mode = selected` is already an allowed value.

/** Marks a job as the Email B image job and binds it to the run it serves. */
interface DeltaImageJobBinding {
  marker: "email-b-delta-images";
  runFingerprint: string;
  baselineFingerprint: string | null;
  expectedImages: number;
}

const DELTA_MARKER = "email-b-delta-images";
const deltaBindingPath = (jobId: string) => `jobs/${jobId}/delta.json`;

// STEP 90C — there is no byte ceiling here any more, and that is the fix, not a
// relaxation. The old DELTA_STAGE_MAX_BYTES measured the ARCHIVE (330 MB, under
// its 400 MB limit, so it never fired) while the real constraint was PEAK
// MEMORY, which the buffering implementation drove to twice that. Streaming
// makes peak memory independent of archive size, so the quantity the ceiling
// was guessing at no longer varies. The provider's own limits still apply.
const deltaTusPorts = makeTusPorts(BUCKET);

async function readDeltaBinding(jobId: string): Promise<DeltaImageJobBinding | null> {
  const raw = await getJson<Record<string, unknown>>(deltaBindingPath(jobId));
  if (!raw || raw.marker !== DELTA_MARKER) return null;
  const run = typeof raw.runFingerprint === "string" ? raw.runFingerprint : "";
  const expected = typeof raw.expectedImages === "number" ? raw.expectedImages : -1;
  if (run === "" || expected < 0) return null;
  return {
    marker: DELTA_MARKER,
    runFingerprint: run,
    baselineFingerprint: typeof raw.baselineFingerprint === "string" ? raw.baselineFingerprint : null,
    expectedImages: expected,
  };
}

/**
 * Start (or resume) the image job for the CURRENT Email B delta.
 *
 * Unlike the certified start, this one never adopts a job it did not create:
 * an active full-catalogue export is reported as a conflict rather than
 * resumed, because staging its 2501-image artifact as "the new-product images"
 * is precisely the wrong package.
 */
export async function startTalabatDeltaImageJob(input: {
  selectedKeys: readonly string[];
  /**
   * STEP 90C — the certified rows the caller ALREADY loaded to compute the
   * delta. Passed in rather than re-read: loading the whole catalogue twice in
   * one request is what pushed this endpoint into an out-of-memory kill.
   */
  previewRows: readonly TalabatPreviewRow[];
  runFingerprint: string;
  baselineFingerprint: string | null;
  actor: string | null;
}): Promise<TalabatJobApiResult<TalabatJobStatusDTO>> {
  if (input.selectedKeys.length === 0) return errResult("no_exportable_rows", 422);
  const admin = createAdminClient();

  const existing = await admin
    .from("talabat_package_jobs").select(ROW_SELECT)
    .eq("channel", CHANNEL).in("status", ["queued", "running"])
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (existing.error && String((existing.error as { code?: string }).code ?? "") === UNDEFINED_TABLE) {
    return errResult("jobs_unavailable", 503);
  }
  const live = existing.data as unknown as JobRow | null;
  if (live) {
    const binding = await readDeltaBinding(live.id);
    const st = await readState(live.id);
    const pl = await getJson<TalabatPackageJobPlan>(planPath(live.id));
    // Resume ONLY our own job, and only while it still serves this run.
    if (binding && binding.runFingerprint === input.runFingerprint && st && pl) {
      return { ok: true, value: statusDTO(st, pl, live) };
    }
    // STEP 90C — which abandoned jobs may be reaped, in order of danger.
    //
    // The previous rule treated a MISSING binding as "not ours, never touch",
    // which sounded safe and was not: a start request killed between the plan
    // write and the binding write leaves a row with no binding, so that row
    // became unreapable for ever and blocked every future preparation. Job
    // c2e53b7a did exactly that in production.
    const fresh = Date.now() - new Date(live.updated_at).getTime() < STALE_MS;
    // 1. A live job is never disturbed, whoever owns it.
    if (fresh) return errResult("conflict", 409);
    // 2. Durable work is never destroyed: an artifact exists, so this job can
    //    still resume its finalization without re-fetching a single image.
    if (st?.artifact != null && st.status !== "completed") return errResult("conflict", 409);
    // 3. NO STATE AT ALL means the start request died before writing any: the
    //    row owns no parts, and no driver — ours or the certified one — can
    //    ever advance it, because both read state.json first. Reapable
    //    regardless of who created it, precisely because it holds nothing.
    // 4. Our own stale job with no durable artifact is reapable.
    if (!st || binding) {
      await reapStaleJob(live.id);
    } else {
      // Stale, has state, and is not ours — someone else's business.
      return errResult("conflict", 409);
    }
  }

  const jobId = randomUUID();
  const created = createTalabatPackageJob({
    jobId, mode: "selected", selectedKeys: input.selectedKeys,
    previewRows: input.previewRows, actor: input.actor, nowIso: new Date().toISOString(),
  });
  if (!created.ok) return errResult("no_exportable_rows", 422);

  const progress = jobProgress(created.state, created.plan);
  const inserted = await admin
    .from("talabat_package_jobs")
    .insert({
      id: jobId, channel: CHANNEL, mode: "selected", status: "running",
      stage: created.state.stage, step: 0,
      progress_current: 0, progress_total: progress.progressTotal,
      rows_total: progress.rowsTotal,
      products_total: created.plan.counts.simpleProductCount + created.plan.counts.variantRowCount,
      created_by: input.actor,
    })
    .select("id").maybeSingle();
  if (inserted.error) {
    const pgCode = String((inserted.error as { code?: string }).code ?? "");
    if (pgCode === UNDEFINED_TABLE) return errResult("jobs_unavailable", 503);
    // Lost the race to some other job — never adopt it, just say so.
    return errResult(pgCode === UNIQUE_VIOLATION ? "conflict" : "generation_failed", pgCode === UNIQUE_VIOLATION ? 409 : 503);
  }

  const binding: DeltaImageJobBinding = {
    marker: DELTA_MARKER,
    runFingerprint: input.runFingerprint,
    baselineFingerprint: input.baselineFingerprint,
    expectedImages: created.plan.images.length,
  };
  // The binding goes FIRST, and it is tiny. If the request dies part-way from
  // here, the row is still identifiable as ours and reapable on its own terms,
  // rather than becoming an anonymous block on every future start.
  await putObject(deltaBindingPath(jobId), json(binding), "application/json");
  await putObject(planPath(jobId), json(created.plan), "application/json");
  await putObject(statePath(jobId), json(created.state), "application/json");
  return { ok: true, value: statusDTO(created.state, created.plan, null) };
}

/** Drive the delta image job one bounded step. Refuses any other job. */
export async function stepTalabatDeltaImageJob(jobId: string): Promise<TalabatJobApiResult<TalabatJobStatusDTO>> {
  const admin = createAdminClient();
  if (await readDeltaBinding(jobId) === null) return errResult("job_not_found", 404);

  const row = await admin.from("talabat_package_jobs").select(ROW_SELECT).eq("id", jobId).maybeSingle();
  if (row.error) {
    return errResult(String((row.error as { code?: string }).code ?? "") === UNDEFINED_TABLE ? "jobs_unavailable" : "job_not_found", 503);
  }
  if (!row.data) return errResult("job_not_found", 404);
  const seen = row.data as unknown as JobRow;

  const state = await readState(jobId);
  const plan = await getJson<TalabatPackageJobPlan>(planPath(jobId));
  if (!state || !plan) return errResult("job_not_found", 404);
  if (state.status !== "running") return { ok: true, value: statusDTO(state, plan, seen) };

  const claim = await admin
    .from("talabat_package_jobs")
    .update({ step: seen.step + 1, updated_at: new Date().toISOString() })
    .eq("id", jobId).eq("step", seen.step).select("id");
  if (claim.error || !Array.isArray(claim.data) || claim.data.length === 0) {
    return { ok: true, value: statusDTO(state, plan, seen) };
  }

  // No syncMappings, no recordAudit — see the section note above.
  const next = await advanceTalabatPackageJob(state, plan, {
    ports: enginePorts,
    imagesOnlyArchive: true,
    correctExtensionFromBytes: true,
  });

  await putObject(statePath(jobId), json(next), "application/json");
  if (next.status === "failed" && !isRecoverableTalabatJobError(next.error?.code)) {
    await cleanupJobArtifacts(jobId);
  }
  const progress = jobProgress(next, plan);
  const nowIso = new Date().toISOString();
  await admin.from("talabat_package_jobs").update({
    status: next.status, stage: progress.stage,
    progress_current: progress.progressCurrent, progress_total: progress.progressTotal,
    rows_total: progress.rowsTotal, bytes_done: progress.bytesDone,
    artifact_filename: next.artifact?.filename ?? null,
    artifact_bytes: next.artifact?.totalBytes ?? null,
    artifact_sha256: next.artifact?.sha256 ?? null,
    manifest_fingerprint: next.artifact?.manifestFingerprint ?? null,
    error_code: next.error?.code ?? null, error_ref: next.error?.refId ?? null,
    completed_at: next.status === "completed" ? nowIso : null,
    updated_at: nowIso,
  }).eq("id", jobId);

  const after = await admin.from("talabat_package_jobs").select(ROW_SELECT).eq("id", jobId).maybeSingle();
  return { ok: true, value: statusDTO(next, plan, (after.data as unknown as JobRow | null) ?? seen) };
}

/**
 * Staging outcome. The failure arm can carry the coverage audit: "incomplete"
 * is only actionable if it says WHICH images are missing.
 */
export type DeltaImageStageOutcome =
  | { ok: true; value: DeltaImageStageResult }
  | {
      ok: false; error: TalabatJobUiErrorCode; status: number;
      coverage?: DeltaImageCoverage; missingRefs?: { filename: string; sku: string }[];
    };

export interface DeltaImageStageResult {
  coverage: DeltaImageCoverage;
  meta: DeltaImageMeta;
  /** filename + SKU of every planned image the job could not retrieve. */
  missingRefs: { filename: string; sku: string }[];
  /** false ⇒ the identical package was already published; nothing was rewritten. */
  republished: boolean;
}

/**
 * Publish a COMPLETED delta job's archive as the current Email B image source.
 *
 * Fails closed on an incomplete package. The owner asked for the exact missing
 * references rather than a count, so a short package returns them and stages
 * nothing: a partner receiving 600 of 632 photographs with no warning is worse
 * than a partner receiving no email.
 */
export async function stageTalabatDeltaImagePackage(jobId: string): Promise<DeltaImageStageOutcome> {
  const binding = await readDeltaBinding(jobId);
  if (binding === null) return errResult("job_not_found", 404);
  const state = await readState(jobId);
  const plan = await getJson<TalabatPackageJobPlan>(planPath(jobId));
  if (!state || !plan) return errResult("job_not_found", 404);
  if (state.status !== "completed" || !state.artifact) return errResult("conflict", 409);

  const coverage = auditDeltaImageCoverage({
    expected: plan.images.length,
    packagedNames: state.packaged.map((p) => p.name),
    droppedCount: state.droppedImages.length,
  });
  const missingRefs = state.droppedImages
    .map((i) => plan.images[i])
    .filter((img): img is NonNullable<typeof img> => Boolean(img))
    .map((img) => ({ filename: img.filename, sku: plan.rows[img.rowIndex]?.sku ?? "" }));
  if (!coverage.complete) {
    return { ok: false, error: "integrity_failed", status: 409, coverage, missingRefs };
  }

  const meta: DeltaImageMeta = {
    imageCount: coverage.packaged,
    expectedImages: coverage.expected,
    extensionAudit: state.extensionAudit ?? { mismatches: 0, renamed: 0, collisions: 0 },
    runFingerprint: binding.runFingerprint,
    baselineFingerprint: binding.baselineFingerprint,
    jobId,
    stagedAtIso: new Date().toISOString(),
    zipBytes: state.artifact.totalBytes,
    sha256: null,
  };

  // IDEMPOTENT. Re-publishing 330 MB that is already published is minutes of
  // upload and a window where the object is half-rewritten, so an existing
  // sidecar describing THIS job, THIS run and THIS baseline, backed by a stored
  // object of exactly the right size, is accepted as done.
  const existing = parseDeltaImageMeta(await getJson<unknown>(DELTA_IMAGE_META_PATH));
  if (existing
    && existing.jobId === jobId
    && existing.runFingerprint === meta.runFingerprint
    && existing.baselineFingerprint === meta.baselineFingerprint
    && existing.imageCount === meta.imageCount
    && existing.zipBytes === meta.zipBytes) {
    const stored = await deltaTusPorts.statObject(DELTA_IMAGE_ZIP_PATH);
    if (stored === existing.zipBytes) {
      return { ok: true, value: { coverage, meta: existing, missingRefs, republished: false } };
    }
  }

  // STREAMED. The archive is the ordered concatenation of the job's durable
  // parts, uploaded one bounded chunk at a time by the same resumable uploader
  // the Rafeeq artifact uses. The whole ZIP is never resident: buffering it was
  // what killed the first staging attempts.
  const streamed = await streamPartsToObject(
    {
      objectPath: DELTA_IMAGE_ZIP_PATH,
      parts: state.parts.map((p) => ({ path: p.path, bytes: p.bytes })),
      totalBytes: state.artifact.totalBytes,
    },
    { readPart: readTalabatPackagePart, ...deltaTusPorts },
  );
  if (!streamed.ok) {
    return errResult(streamed.error === "part_missing" ? "job_not_found" : "upload_incomplete", 502);
  }
  meta.sha256 = streamed.sha256;

  // The sidecar is written only after the object is uploaded AND its stored
  // size verified, so a sidecar can never describe an archive that is not there.
  try {
    await putObject(DELTA_IMAGE_META_PATH, json(meta), "application/json");
  } catch {
    return errResult("upload_incomplete", 502);
  }
  return { ok: true, value: { coverage, meta, missingRefs, republished: true } };
}

/**
 * The most recent COMPLETED delta image job that could be published for the
 * given run — the recovery path. Its images are already downloaded and durable,
 * so publishing is a stream-and-record, never a re-fetch.
 */
export async function findStageableDeltaImageJob(
  runFingerprint: string,
): Promise<{ jobId: string; imageCount: number; archiveBytes: number; completedAtIso: string } | null> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("talabat_package_jobs")
      .select("id, completed_at, artifact_bytes, progress_current")
      .eq("channel", CHANNEL).eq("mode", "selected").eq("status", "completed")
      .order("completed_at", { ascending: false }).limit(5);
    if (error || !Array.isArray(data)) return null;
    for (const row of data as unknown as {
      id: string; completed_at: string | null; artifact_bytes: number | null; progress_current: number | null;
    }[]) {
      const binding = await readDeltaBinding(row.id);
      // Only a job built for THIS comparison may be published for it.
      if (!binding || binding.runFingerprint !== runFingerprint) continue;
      const st = await readState(row.id);
      if (!st || st.status !== "completed" || !st.artifact) continue;
      return {
        jobId: row.id,
        imageCount: st.packaged.length,
        archiveBytes: st.artifact.totalBytes,
        completedAtIso: row.completed_at ?? "",
      };
    }
    return null;
  } catch {
    return null;
  }
}
