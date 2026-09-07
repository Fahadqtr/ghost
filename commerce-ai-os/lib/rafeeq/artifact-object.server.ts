// RAFEEQ.PKGLINK — certified single-object artifact + signed direct link
// (SERVER-ONLY; the route gates it to the OWNER).
//
// ensure: idempotently assembles jobs/<id>'s certified parts into ONE object
//         (artifacts/<jobId>/<certified-filename>) in the SAME private
//         `rafeeq-packages` bucket via Supabase's TUS resumable upload,
//         verifying size and recording SHA-256 of the exact bytes in
//         jobs/<id>/artifact-object.json. Never regenerates anything — the
//         inputs are the already-stored certified parts.
// sign:   creates a scoped signed URL (default 7 days) served DIRECTLY by
//         Supabase Storage/CDN — the download never touches a Next.js/Vercel
//         route, supports HTTP Range/resume, and carries Content-Disposition
//         with the certified filename. A fresh link can be created any time
//         from the existing object (signed URLs are stateless).
//
// Failure safety: no metadata is recorded unless upload + size verification
// succeeded, and the send layer refuses to email without verified metadata.

import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import {
  assembleRafeeqArtifactObject,
  artifactMetaMatches,
  RAFEEQ_LINK_TTL_SECONDS,
  type RafeeqArtifactObjectMeta,
} from "@/lib/export/rafeeq/artifact-object";
import { getRafeeqPackageArtifact, readRafeeqPackagePart, RAFEEQ_JOB_BUCKET } from "@/lib/rafeeq/package-job.server";
import { makeTusPorts } from "@/lib/storage/tus.server";

const metaPath = (jobId: string) => `jobs/${jobId}/artifact-object.json`;

export type RafeeqArtifactLinkError = "job_not_found" | "package_link_unavailable";
export type RafeeqLinkApiResult<T> = { ok: true; value: T } | { ok: false; error: RafeeqArtifactLinkError; status: number };
const linkErr = <T,>(error: RafeeqArtifactLinkError, status: number): RafeeqLinkApiResult<T> => ({ ok: false, error, status });

// ── TUS ports (the shared implementation, bound to this bucket) ─────────────
//
// STEP 90C — these three calls moved to lib/storage/tus.server.ts so Email B's
// image package could use the same resumable upload instead of a second copy.
// Same protocol, same headers, same offsets; only the bucket is a parameter.

const { tusCreate, tusPatch, statObject } = makeTusPorts(RAFEEQ_JOB_BUCKET);

async function readMeta(jobId: string): Promise<RafeeqArtifactObjectMeta | null> {
  const admin = createAdminClient();
  const { data, error } = await admin.storage.from(RAFEEQ_JOB_BUCKET).download(metaPath(jobId));
  if (error || !data) return null;
  try {
    return JSON.parse(new TextDecoder().decode(new Uint8Array(await data.arrayBuffer()))) as RafeeqArtifactObjectMeta;
  } catch {
    return null;
  }
}

async function writeMeta(meta: RafeeqArtifactObjectMeta): Promise<boolean> {
  const admin = createAdminClient();
  const { error } = await admin.storage
    .from(RAFEEQ_JOB_BUCKET)
    .upload(metaPath(meta.jobId), new TextEncoder().encode(JSON.stringify(meta, null, 2)), {
      contentType: "application/json",
      upsert: true,
    });
  return !error;
}

/**
 * Idempotently make sure the certified single-object artifact exists and is
 * verified for this COMPLETED job. Reuses existing verified metadata; only
 * assembles (from the stored certified parts) when absent or stale.
 */
export async function ensureRafeeqArtifactObject(jobId: string): Promise<RafeeqLinkApiResult<RafeeqArtifactObjectMeta>> {
  const artifact = await getRafeeqPackageArtifact(jobId);
  if (!artifact.ok) return linkErr("job_not_found", artifact.status);
  const { filename, totalBytes, parts } = artifact.value;

  const existing = await readMeta(jobId);
  if (existing && artifactMetaMatches(existing, filename, totalBytes)) {
    const stored = await statObject(existing.objectPath);
    if (stored === totalBytes) return { ok: true, value: existing };
  }

  const assembled = await assembleRafeeqArtifactObject(
    { jobId, filename, parts, totalBytes, nowIso: new Date().toISOString() },
    { readPart: readRafeeqPackagePart, tusCreate, tusPatch, statObject, writeMeta },
  );
  if (!assembled.ok) return linkErr("package_link_unavailable", 502);
  return { ok: true, value: assembled.meta };
}

export interface RafeeqPackageLinkDTO {
  url: string;
  expiresAtIso: string;
  filename: string;
  bytes: number;
  sha256: string;
}

/**
 * A fresh scoped signed URL for the verified stored object (default 7 days).
 * Stateless — the owner can call this again any time (e.g. after expiry)
 * without regenerating anything.
 */
export async function createRafeeqPackageSignedLink(
  jobId: string,
  expiresInSeconds: number = RAFEEQ_LINK_TTL_SECONDS,
): Promise<RafeeqLinkApiResult<RafeeqPackageLinkDTO>> {
  const ensured = await ensureRafeeqArtifactObject(jobId);
  if (!ensured.ok) return ensured;
  const meta = ensured.value;
  const admin = createAdminClient();
  const { data, error } = await admin.storage
    .from(RAFEEQ_JOB_BUCKET)
    .createSignedUrl(meta.objectPath, expiresInSeconds, { download: meta.filename });
  if (error || !data?.signedUrl) return linkErr("package_link_unavailable", 502);
  return {
    ok: true,
    value: {
      url: data.signedUrl,
      expiresAtIso: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
      filename: meta.filename,
      bytes: meta.bytes,
      sha256: meta.sha256,
    },
  };
}
