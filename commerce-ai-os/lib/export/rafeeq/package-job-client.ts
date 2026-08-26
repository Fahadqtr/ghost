// RAFEEQ.PKGJOB — shared CLIENT driver for the chunked package-job flow (PURE).
//
// Both Rafeeq generation surfaces (the INT.2D export card's "توليد الحزمة" and
// the FullSync card's "توليد كتالوج رفيق الكامل") drive the SAME job endpoints
// through this one module — start → bounded steps → completed status — so the
// old buffered single-request path is unreachable from any UI and the job
// engine logic is never duplicated.
//
// Response safety: only structured JSON is ever interpreted. A non-JSON body
// (e.g. an upstream HTML error page after a platform kill) maps to the fixed
// Arabic "network" message — raw response text NEVER reaches the page.

export type RafeeqJobApiMode = "full" | "new_pending";

/** Explicit, deterministic mapping from the legacy INT.2D surface's mode to
 *  the job API mode. Only "all" maps — "new"/"selected" are bounded subset
 *  packages that keep their existing (non-full-catalog) behavior. */
export const LEGACY_MODE_TO_JOB_MODE: Partial<Record<string, RafeeqJobApiMode>> = {
  all: "full",
};

export interface RafeeqJobStatus {
  jobId: string;
  status: "running" | "complete" | "failed";
  phase: "images" | "finalize" | "done" | "failed";
  productsDone: number;
  productsTotal: number;
  imagesDone: number;
  bytesDone: number;
  artifact: { filename: string; totalBytes: number } | null;
  packageRecorded: boolean;
  error: { code: string; refId: string } | null;
}

export type RafeeqJobReadResult =
  | { ok: true; value: RafeeqJobStatus }
  | { ok: false; code: string; refId: string | null };

/** Read a job API response SAFELY — structured JSON only, never raw text. */
export async function readJobResponse(res: Response): Promise<RafeeqJobReadResult> {
  const isJson = (res.headers.get("content-type") ?? "").includes("application/json");
  if (!isJson) return { ok: false, code: "network", refId: null };
  try {
    const body = await res.json();
    if (!res.ok) return { ok: false, code: typeof body?.error === "string" ? body.error : "network", refId: null };
    return { ok: true, value: body as RafeeqJobStatus };
  } catch {
    return { ok: false, code: "network", refId: null };
  }
}

/** The streamed-download URL for a completed job's artifact. */
export function rafeeqJobDownloadUrl(jobId: string): string {
  return `/api/export/rafeeq/package/jobs/${jobId}/download`;
}

/**
 * Drive one generation to completion: idempotent start (a live job for the
 * mode is resumed, never duplicated — retry-safe by construction), then
 * bounded step requests until the job completes or fails. `onProgress` fires
 * before every step with the latest status.
 */
export async function driveRafeeqPackageJob(
  mode: RafeeqJobApiMode,
  onProgress: (s: RafeeqJobStatus) => void,
): Promise<RafeeqJobReadResult> {
  const startRes = await fetch(`/api/export/rafeeq/package/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  const started = await readJobResponse(startRes);
  if (!started.ok) return started;

  let status = started.value;
  while (status.status === "running") {
    onProgress(status);
    const stepRes = await fetch(`/api/export/rafeeq/package/jobs/${status.jobId}`, { method: "POST" });
    const step = await readJobResponse(stepRes);
    if (!step.ok) return step;
    status = step.value;
  }
  if (status.status === "failed") {
    return { ok: false, code: status.error?.code ?? "generation_failed", refId: status.error?.refId ?? null };
  }
  return { ok: true, value: status };
}
