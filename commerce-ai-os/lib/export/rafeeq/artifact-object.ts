// RAFEEQ.PKGLINK — single-object artifact assembly (PURE, port-driven).
//
// Owner contract (FAST DELIVERY LINK):
//   • the certified package bytes are PRESERVED EXACTLY — the single storage
//     object is the ordered byte concatenation of the already-stored job
//     parts (the same certified parts the streamed download serves); nothing
//     is regenerated or recompressed;
//   • SHA-256 is computed over exactly the bytes uploaded, part by part, so
//     the recorded hash IS the hash of the certified ZIP;
//   • the upload is chunked (TUS resumable protocol — Supabase requires each
//     chunk except the last to be a 6 MiB multiple), so at most one part +
//     one carry buffer is ever in memory — never the whole ZIP;
//   • the stored object size is verified against the completed package's
//     total before any metadata is recorded;
//   • ANY failure records nothing — a missing/unverified object can never be
//     linked in an email (the send layer blocks on absent metadata).

import {
  streamPartsToObject, TUS_CHUNK_BYTES, TUS_MAX_PATCH_BYTES,
  type StreamedAssemblyPorts,
} from "../artifact-stream.ts";

// STEP 90C — the streaming assembly moved to ../artifact-stream.ts so Email B's
// image package could use the SAME uploader instead of a second one. The
// protocol, the chunk arithmetic and the byte order are unchanged; these
// re-exports keep every existing importer working.
export { TUS_CHUNK_BYTES, TUS_MAX_PATCH_BYTES };

/** default signed-link lifetime: 7 days. */
export const RAFEEQ_LINK_TTL_SECONDS = 7 * 24 * 3600;

export const artifactObjectPath = (jobId: string, filename: string) => `artifacts/${jobId}/${filename}`;

export interface RafeeqArtifactObjectMeta {
  version: 1;
  jobId: string;
  objectPath: string;
  filename: string;
  bytes: number;
  sha256: string;
  partCount: number;
  uploadedAtIso: string;
}

export type RafeeqArtifactObjectError =
  | "part_missing"
  | "upload_failed"
  | "size_mismatch"
  | "meta_write_failed";

export interface RafeeqArtifactObjectPorts extends StreamedAssemblyPorts {
  /** persist the metadata record. false = write failed. */
  writeMeta(meta: RafeeqArtifactObjectMeta): Promise<boolean>;
}

export interface RafeeqArtifactObjectInput {
  jobId: string;
  filename: string;
  parts: readonly { path: string; bytes: number }[];
  totalBytes: number;
  nowIso: string;
}

/**
 * Assemble the certified parts into ONE stored object and record verified
 * metadata. Bounded memory; hash-of-exact-bytes; verify-then-record.
 */
export async function assembleRafeeqArtifactObject(
  input: RafeeqArtifactObjectInput,
  ports: RafeeqArtifactObjectPorts,
): Promise<{ ok: true; meta: RafeeqArtifactObjectMeta } | { ok: false; error: RafeeqArtifactObjectError }> {
  const objectPath = artifactObjectPath(input.jobId, input.filename);
  const streamed = await streamPartsToObject(
    { objectPath, parts: input.parts, totalBytes: input.totalBytes },
    ports,
  );
  if (!streamed.ok) return { ok: false, error: streamed.error };

  const meta: RafeeqArtifactObjectMeta = {
    version: 1,
    jobId: input.jobId,
    objectPath,
    filename: input.filename,
    bytes: input.totalBytes,
    sha256: streamed.sha256,
    partCount: streamed.partCount,
    uploadedAtIso: input.nowIso,
  };
  if (!(await ports.writeMeta(meta))) return { ok: false, error: "meta_write_failed" };
  return { ok: true, meta };
}

/** meta is trustworthy for linking only when it matches the completed state. */
export function artifactMetaMatches(meta: RafeeqArtifactObjectMeta, filename: string, totalBytes: number): boolean {
  return meta.version === 1 && meta.filename === filename && meta.bytes === totalBytes && /^[0-9a-f]{64}$/.test(meta.sha256);
}
