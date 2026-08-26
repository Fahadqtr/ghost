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

const metaPath = (jobId: string) => `jobs/${jobId}/artifact-object.json`;

export type RafeeqArtifactLinkError = "job_not_found" | "package_link_unavailable";
export type RafeeqLinkApiResult<T> = { ok: true; value: T } | { ok: false; error: RafeeqArtifactLinkError; status: number };
const linkErr = <T,>(error: RafeeqArtifactLinkError, status: number): RafeeqLinkApiResult<T> => ({ ok: false, error, status });

function supabaseStorageEnv(): { url: string; key: string } | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? { url: url.replace(/\/$/, ""), key } : null;
}

// ── real TUS ports (Supabase resumable upload) ───────────────────────────────

async function tusCreate(objectPath: string, totalBytes: number): Promise<string | null> {
  const env = supabaseStorageEnv();
  if (!env) return null;
  const b64 = (v: string) => Buffer.from(v, "utf8").toString("base64");
  try {
    const res = await fetch(`${env.url}/storage/v1/upload/resumable`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.key}`,
        apikey: env.key,
        "tus-resumable": "1.0.0",
        "upload-length": String(totalBytes),
        "x-upsert": "true",
        "upload-metadata": [
          `bucketName ${b64(RAFEEQ_JOB_BUCKET)}`,
          `objectName ${b64(objectPath)}`,
          `contentType ${b64("application/zip")}`,
          `cacheControl ${b64("3600")}`,
        ].join(","),
      },
    });
    if (res.status !== 201) return null;
    const location = res.headers.get("location");
    if (!location) return null;
    return location.startsWith("http") ? location : `${env.url}${location}`;
  } catch {
    return null;
  }
}

async function tusPatch(uploadUrl: string, offset: number, chunk: Uint8Array): Promise<number | null> {
  const env = supabaseStorageEnv();
  if (!env) return null;
  try {
    const res = await fetch(uploadUrl, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${env.key}`,
        apikey: env.key,
        "tus-resumable": "1.0.0",
        "upload-offset": String(offset),
        "Content-Type": "application/offset+octet-stream",
      },
      body: new Uint8Array(chunk),
    });
    if (res.status !== 204) return null;
    const next = Number.parseInt(res.headers.get("upload-offset") ?? "", 10);
    return Number.isInteger(next) ? next : null;
  } catch {
    return null;
  }
}

async function statObject(objectPath: string): Promise<number | null> {
  const admin = createAdminClient();
  const dir = objectPath.slice(0, objectPath.lastIndexOf("/"));
  const name = objectPath.slice(objectPath.lastIndexOf("/") + 1);
  const { data, error } = await admin.storage.from(RAFEEQ_JOB_BUCKET).list(dir, { limit: 100 });
  if (error || !data) return null;
  const row = data.find((o: { name: string; metadata?: { size?: number } | null }) => o.name === name);
  const size = row?.metadata?.size;
  return typeof size === "number" ? size : null;
}

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
