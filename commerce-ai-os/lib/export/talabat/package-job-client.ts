// TALABAT.PKGJOB — CLIENT driver + progress formatting for the chunked job (PURE).
//
// The browser drives generation as a sequence of BOUNDED step requests instead
// of one long request: start → step → step → … → completed. Each step returns
// the current status, so the step response doubles as the progress poll and no
// request ever stays open long enough to hit FUNCTION_INVOCATION_TIMEOUT.
//
// Response safety: only structured JSON is ever interpreted. A non-JSON body
// (e.g. an upstream HTML platform-error page) maps to the fixed Arabic
// "network" message — raw response text NEVER reaches the page.

import { talabatJobErrorMessageAr, type TalabatJobStage } from "./package-job-errors.ts";

export interface TalabatJobStatus {
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
  /** STEP 76 — retry continues this job; it does NOT re-download images. */
  resumable: boolean;
}

export type TalabatJobReadResult =
  | { ok: true; value: TalabatJobStatus }
  | { ok: false; code: string; refId: string | null };

/** Read a job API response SAFELY — structured JSON only, never raw text. */
export async function readJobResponse(res: Response): Promise<TalabatJobReadResult> {
  const isJson = (res.headers.get("content-type") ?? "").includes("application/json");
  if (!isJson) return { ok: false, code: "network", refId: null };
  try {
    const body = await res.json();
    if (!res.ok) return { ok: false, code: typeof body?.error === "string" ? body.error : "network", refId: null };
    return { ok: true, value: body as TalabatJobStatus };
  } catch {
    return { ok: false, code: "network", refId: null };
  }
}

/** The streamed-download URL for a completed job's artifact. */
export function talabatJobDownloadUrl(jobId: string): string {
  return `/api/export/talabat/package/jobs/${jobId}/download`;
}

// ── progress formatting (pure — unit-tested without a DOM) ───────────────────

/** mm:ss (or h:mm:ss past an hour) for a duration in milliseconds. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0:00";
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

/** HH:MM in the viewer's locale, from an ISO timestamp. */
export function formatClock(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * Estimated milliseconds remaining, or null when there is not yet enough
 * progress to estimate sensibly. Deliberately conservative: an ETA shown too
 * early is worse than no ETA, so it needs both a minimum share of the work and
 * a minimum absolute number of completed units.
 */
export const ETA_MIN_PERCENT = 5;
export const ETA_MIN_UNITS = 20;

export function estimateRemainingMs(input: {
  elapsedMs: number;
  current: number;
  total: number;
}): number | null {
  const { elapsedMs, current, total } = input;
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return null;
  if (total <= 0 || current <= 0 || current >= total) return null;
  if (current < ETA_MIN_UNITS) return null;
  if ((current / total) * 100 < ETA_MIN_PERCENT) return null;
  const perUnit = elapsedMs / current;
  return Math.round(perUnit * (total - current));
}

/** The safe Arabic message for a job error code. */
export function jobErrorMessage(code: string | null | undefined): string {
  return talabatJobErrorMessageAr(code);
}

/** Human byte size (the artifact is ~800 MB, so MB/GB matter). */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

// ── the driver ───────────────────────────────────────────────────────────────

export interface DriveOptions {
  mode?: "ready" | "selected";
  selectedKeys?: readonly string[];
  /** fired with every status the driver observes (start + each step). */
  onProgress: (s: TalabatJobStatus) => void;
  /** cooperative cancel — the driver stops requesting further steps. */
  shouldStop?: () => boolean;
  fetchImpl?: typeof fetch;
}

/**
 * Drive one generation to completion: idempotent start (a live job for the
 * channel is resumed, never duplicated — retry-safe by construction), then
 * bounded step requests until the job completes or fails.
 *
 * Polling stops automatically on `completed` and on `failed` — the loop
 * condition is `status === "running"`, so neither terminal state issues another
 * request.
 */
export async function driveTalabatPackageJob(opts: DriveOptions): Promise<TalabatJobReadResult> {
  const f = opts.fetchImpl ?? fetch;
  const startRes = await f(`/api/export/talabat/package/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: opts.mode ?? "ready", selectedKeys: opts.selectedKeys }),
  });
  const started = await readJobResponse(startRes);
  if (!started.ok) return started;

  let status = started.value;
  opts.onProgress(status);

  while (status.status === "running" || status.status === "queued") {
    if (opts.shouldStop?.()) return { ok: true, value: status };
    const stepRes = await f(`/api/export/talabat/package/jobs/${status.jobId}`, { method: "POST" });
    const step = await readJobResponse(stepRes);
    if (!step.ok) return step;
    status = step.value;
    opts.onProgress(status);
  }

  if (status.status === "failed") {
    return { ok: false, code: status.error?.code ?? "generation_failed", refId: status.error?.refId ?? null };
  }
  return { ok: true, value: status };
}
