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
  created_by: string | null;
  started_at: string;
  updated_at: string;
  completed_at: string | null;
}

const ROW_SELECT = "id, mode, status, stage, step, created_by, started_at, updated_at, completed_at";

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
    mappingsSynced: state.mappingSync?.ok === true,
    auditRecorded: state.auditRecorded,
    error: state.error,
  };
}

// ── public API ────────────────────────────────────────────────────────────────

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
    if (fresh) {
      // A genuinely live job — RESUME it rather than starting a second one.
      const st = await getJson<TalabatPackageJobState>(statePath(live.id));
      const pl = await getJson<TalabatPackageJobPlan>(planPath(live.id));
      if (st && pl) return { ok: true, value: statusDTO(st, pl, live) };
    } else {
      // STEP 75 — STALE. It is not enough to ignore the row: leaving it
      // queued/running forever would both leak its parts and (with the partial
      // unique index) permanently block every replacement. Transition it out of
      // the active set ATOMICALLY, then clean its temporary parts. The `.in`
      // guard means exactly one racer wins the reap; the loser's update matches
      // no row and it proceeds to the insert, where the unique index arbitrates.
      await reapStaleJob(live.id);
    }
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
        const st = await getJson<TalabatPackageJobState>(statePath(row.id));
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
  const state = await getJson<TalabatPackageJobState>(statePath(jobId));
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

  const state = await getJson<TalabatPackageJobState>(statePath(jobId));
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
    syncMappings: async (actor) => {
      const r = await syncTalabatMappingsFromCatalog(actor ?? "");
      return { ok: r.ok, inserted: r.counts?.inserted ?? 0, updated: r.counts?.updated ?? 0, failed: r.counts?.failed ?? 0 };
    },
    recordAudit,
  });

  await putObject(statePath(jobId), json(next), "application/json");
  // STEP 75 — a job that just FAILED will never be resumed (retry starts a new
  // job), so its parts are dead weight: up to ~800 MB per failure. Clean them
  // now, scoped to this job's own prefix. Best-effort by construction — a
  // cleanup problem must not change the recorded failure.
  if (next.status === "failed") await cleanupJobArtifacts(jobId);
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
  const state = await getJson<TalabatPackageJobState>(statePath(jobId));
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
