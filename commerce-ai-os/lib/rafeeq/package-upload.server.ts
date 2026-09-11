// RAFEEQ PACKAGE UPLOAD — server side (SERVER-ONLY; routes gate it to the OWNER).
//
// Two calls, and between them the 92 MB never touches this process:
//
//   ticket() — after the OWNER is verified, mints a signed upload credential
//              scoped to one object path and hands it to the browser.
//   verify() — after the browser reports done, checks what actually landed and
//              issues the 7-day download link.
//
// The service key stays here. The browser gets a token that can write to
// exactly one path and do nothing else, and the bucket stays private: the
// download is a signed URL, not a public object.

import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { RAFEEQ_JOB_BUCKET } from "@/lib/rafeeq/package-job.server";
import { RAFEEQ_LINK_TTL_SECONDS } from "@/lib/export/rafeeq/artifact-object";
import {
  rafeeqUploadObjectPath,
  sanitizeUploadFilename,
  verifyRafeeqUploadRequest,
  verifyRafeeqUploadedObject,
  RAFEEQ_UPLOAD_CHUNK_BYTES,
  RAFEEQ_UPLOAD_CONTENT_TYPE,
  type RafeeqUploadBlock,
  type RafeeqUploadRequest,
  type RafeeqUploadTicket,
  type RafeeqUploadLinkDTO,
} from "@/lib/export/rafeeq/package-upload";

export type RafeeqUploadApiError = RafeeqUploadBlock | "storage_unavailable" | "not_configured";
export type RafeeqUploadApiResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: RafeeqUploadApiError; status: number };

const fail = <T,>(error: RafeeqUploadApiError, status: number): RafeeqUploadApiResult<T> => ({ ok: false, error, status });

/**
 * Supabase's resumable endpoint on the DIRECT storage hostname.
 *
 * The docs are explicit that large uploads should not go through the API
 * hostname, so the project ref is lifted out of the configured URL rather than
 * configured twice and allowed to drift.
 */
function resumableEndpoint(): string | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) return null;
  try {
    const host = new URL(url).hostname;                 // <ref>.supabase.co
    const ref = host.split(".")[0];
    if (!ref) return null;
    return `https://${ref}.storage.supabase.co/storage/v1/upload/resumable`;
  } catch {
    return null;
  }
}

/**
 * Mint a scoped upload credential for ONE archive.
 *
 * The destination is derived from the archive's own hash, so calling this
 * twice for the same file returns the same path — the browser's resumable
 * upload then continues instead of starting over — while a different file can
 * never be issued a path that already holds something else.
 */
export async function createRafeeqUploadTicket(
  req: RafeeqUploadRequest,
  nowIso: string = new Date().toISOString(),
): Promise<RafeeqUploadApiResult<RafeeqUploadTicket>> {
  const blocks = verifyRafeeqUploadRequest(req);
  if (blocks.length > 0) return fail(blocks[0], 422);

  const endpoint = resumableEndpoint();
  const apiKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!endpoint || !apiKey) return fail("not_configured", 503);

  const sha256 = req.sha256.toLowerCase();
  const objectPath = rafeeqUploadObjectPath(sha256, req.filename, nowIso);

  let token: string;
  try {
    const admin = createAdminClient();
    const { data, error } = await admin.storage
      .from(RAFEEQ_JOB_BUCKET)
      // upsert so a RESUMED upload of the same bytes may finish onto its own
      // path. The path is hash-derived, so this can only ever overwrite an
      // identical archive — never a package, never a different file.
      .createSignedUploadUrl(objectPath, { upsert: true });
    if (error || !data?.token) return fail("storage_unavailable", 502);
    token = data.token;
  } catch {
    return fail("storage_unavailable", 502);
  }

  return {
    ok: true,
    value: {
      bucket: RAFEEQ_JOB_BUCKET,
      objectPath,
      token,
      endpoint,
      apiKey,
      chunkBytes: RAFEEQ_UPLOAD_CHUNK_BYTES,
      contentType: RAFEEQ_UPLOAD_CONTENT_TYPE,
      expectedBytes: req.bytes,
      expectedSha256: sha256,
    },
  };
}

/** The stored object's size, or null when there is no such object. */
async function storedSize(objectPath: string): Promise<number | null> {
  try {
    const admin = createAdminClient();
    const slash = objectPath.lastIndexOf("/");
    const dir = slash < 0 ? "" : objectPath.slice(0, slash);
    const name = slash < 0 ? objectPath : objectPath.slice(slash + 1);
    const { data, error } = await admin.storage.from(RAFEEQ_JOB_BUCKET).list(dir, { search: name, limit: 100 });
    if (error || !data) return null;
    const hit = data.find((o) => o.name === name);
    const size = (hit?.metadata as { size?: unknown } | undefined)?.size;
    return typeof size === "number" ? size : null;
  } catch {
    return null;
  }
}

/**
 * Confirm what landed, then issue the link.
 *
 * The size is checked HERE, against storage itself, rather than trusted from
 * the browser that just did the uploading. The content hash is verified by the
 * caller downloading the finished link and hashing what comes back — an actual
 * round trip — because re-reading 92 MB inside a serverless function to prove
 * the same thing would be the size limit this design exists to avoid.
 */
export async function verifyRafeeqUploadAndLink(
  objectPath: string,
  expectedBytes: number,
  expectedSha256: string,
  expiresInSeconds: number = RAFEEQ_LINK_TTL_SECONDS,
): Promise<RafeeqUploadApiResult<RafeeqUploadLinkDTO>> {
  const size = await storedSize(objectPath);
  const blocks = verifyRafeeqUploadedObject(size, expectedBytes);
  if (blocks.length > 0) return fail(blocks[0], 409);

  const filename = sanitizeUploadFilename(objectPath);
  try {
    const admin = createAdminClient();
    const { data, error } = await admin.storage
      .from(RAFEEQ_JOB_BUCKET)
      .createSignedUrl(objectPath, expiresInSeconds, { download: filename });
    if (error || !data?.signedUrl) return fail("storage_unavailable", 502);
    return {
      ok: true,
      value: {
        url: data.signedUrl,
        expiresAtIso: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
        filename,
        objectPath,
        bytes: expectedBytes,
        sha256: expectedSha256.toLowerCase(),
      },
    };
  } catch {
    return fail("storage_unavailable", 502);
  }
}
