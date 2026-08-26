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
