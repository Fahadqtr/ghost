// STEP 85G — the resumable-publish contract for the Email B image package (PURE).
//
// Publishing the package means streaming ~324 MB of durable parts into one
// stored object. That does not fit in a single serverless request reliably, and
// the first implementation created a NEW upload on every attempt: each retry
// re-sent from byte 0, ran out of time in roughly the same place, and discarded
// everything the previous attempt had delivered. Four completed 622-image jobs
// sat unpublishable behind it.
//
// The fix is a token: the upload resource, and what it belongs to, written down
// so the next attempt can ask the server where it got to and carry on. This
// module owns the shape of that token and the rule for when it may be trusted.
// It performs no I/O, so the rule is testable on its own.

/** Where the resume token for one job lives. Beside the job's own state. */
export const publishStatePath = (jobId: string) => `jobs/${jobId}/publish.json`;

/**
 * A publish in flight.
 *
 * Every field except `confirmedOffset` and `leaseUntilIso` is an identity claim:
 * together they say WHICH archive this upload is delivering. A token that
 * disagrees with the publish being attempted is not a slow upload to continue,
 * it is a different one, and continuing it would append this run's bytes to
 * another run's object.
 */
export interface DeltaImagePublishState {
  jobId: string;
  objectPath: string;
  uploadUrl: string;
  totalBytes: number;
  runFingerprint: string;
  scopeProducts: number | null;
  scopeRows: number | null;
  /** the last offset the SERVER confirmed. Advisory: the server is re-asked. */
  confirmedOffset: number;
  updatedAtIso: string;
  /** while this is in the future, another attempt owns the upload. */
  leaseUntilIso: string | null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;
const nullableNum = (v: unknown): number | null => num(v);

/** Read a token back. Anything malformed is NOT a token — never a default. */
export function parseDeltaImagePublishState(raw: unknown): DeltaImagePublishState | null {
  if (raw === null || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const jobId = str(o.jobId);
  const objectPath = str(o.objectPath);
  const uploadUrl = str(o.uploadUrl);
  const runFingerprint = str(o.runFingerprint);
  const totalBytes = num(o.totalBytes);
  const confirmedOffset = num(o.confirmedOffset);
  const updatedAtIso = str(o.updatedAtIso);
  if (jobId === null || objectPath === null || uploadUrl === null || runFingerprint === null
    || totalBytes === null || confirmedOffset === null || updatedAtIso === null) {
    return null;
  }
  if (confirmedOffset > totalBytes) return null;
  return {
    jobId, objectPath, uploadUrl, totalBytes, runFingerprint,
    scopeProducts: nullableNum(o.scopeProducts),
    scopeRows: nullableNum(o.scopeRows),
    confirmedOffset, updatedAtIso,
    leaseUntilIso: str(o.leaseUntilIso),
  };
}

/** What the publish being attempted right now is delivering. */
export interface DeltaImagePublishIdentity {
  jobId: string;
  objectPath: string;
  totalBytes: number;
  runFingerprint: string;
}

export type PublishResumeVerdict =
  | { usable: true }
  | { usable: false; reason: "no_state" | "different_job" | "different_path"
      | "different_size" | "different_run" };

/**
 * May this token be resumed for this publish?
 *
 * Fails closed on every mismatch. A token from another job, another target
 * path, another archive size or another comparison is refused outright — the
 * caller then starts a fresh upload, which is safe precisely because nothing
 * of this run was ever appended to that other object.
 */
export function resumeVerdict(
  state: DeltaImagePublishState | null,
  identity: DeltaImagePublishIdentity,
): PublishResumeVerdict {
  if (state === null) return { usable: false, reason: "no_state" };
  if (state.jobId !== identity.jobId) return { usable: false, reason: "different_job" };
  if (state.objectPath !== identity.objectPath) return { usable: false, reason: "different_path" };
  if (state.totalBytes !== identity.totalBytes) return { usable: false, reason: "different_size" };
  if (state.runFingerprint !== identity.runFingerprint) return { usable: false, reason: "different_run" };
  return { usable: true };
}

/**
 * How long one publish attempt owns the upload before it is considered dead.
 *
 * Deliberately just over the route's 300-second ceiling: an attempt cannot
 * outlive that, so six minutes is long enough that a running upload is never
 * interrupted and short enough that a KILLED one — which never reaches its own
 * cleanup — stops blocking the owner's next click a minute later. Renewed on
 * every confirmed chunk, so a long healthy upload keeps its claim.
 */
export const PUBLISH_LEASE_MS = 6 * 60 * 1000;

/**
 * Is another attempt still working on this upload?
 *
 * The lease is time-bounded rather than a flag, so a request killed mid-upload
 * — the exact failure this whole module exists for — releases it on its own.
 * Nothing is deleted to break a lock.
 */
export function publishLeaseHeld(
  state: DeltaImagePublishState | null,
  nowMs: number,
): boolean {
  if (state === null || state.leaseUntilIso === null) return false;
  const until = Date.parse(state.leaseUntilIso);
  return Number.isFinite(until) && until > nowMs;
}

/** What the screen shows about an upload in flight. */
export interface DeltaImagePublishProgress {
  uploadedBytes: number;
  totalBytes: number;
  percent: number;
  resumeAvailable: boolean;
}

export function publishProgressOf(
  state: DeltaImagePublishState | null,
  identity: DeltaImagePublishIdentity,
): DeltaImagePublishProgress | null {
  if (!resumeVerdict(state, identity).usable || state === null) return null;
  const total = state.totalBytes;
  const uploaded = Math.min(state.confirmedOffset, total);
  return {
    uploadedBytes: uploaded,
    totalBytes: total,
    // Floored, so a partial upload never reads as a finished one.
    percent: total > 0 ? Math.floor((uploaded / total) * 100) : 0,
    resumeAvailable: uploaded > 0 && uploaded < total,
  };
}
