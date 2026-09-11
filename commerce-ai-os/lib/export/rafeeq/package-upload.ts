// RAFEEQ PACKAGE UPLOAD — a ready-made archive into the private bucket (PURE).
//
// The Rafeeq package pipeline can already put an archive in `rafeeq-packages`,
// but only one it generated itself: ensureRafeeqArtifactObject assembles the
// certified parts of a completed JOB. An archive prepared outside that job —
// the 156-image answer to Rafeeq's missing-images request, for instance — has
// no way in.
//
// This module decides three things for that case, and performs no I/O:
//   1. WHERE the object lands, so an upload can never overwrite a package;
//   2. WHETHER a proposed upload is allowed at all;
//   3. WHETHER what actually landed is what was promised.
//
// The transport is deliberately NOT a server route. A 92 MB body through a
// serverless function is a platform limit waiting to be hit, so the server
// issues a SIGNED UPLOAD TOKEN and the browser sends the bytes straight to
// Supabase Storage over the resumable (TUS) protocol. The service key never
// leaves the server, the bucket stays private, and an interrupted upload
// resumes from its own offset instead of restarting.

/** 500 MB. Far above the 92 MB case, far below anything that looks accidental. */
export const RAFEEQ_UPLOAD_MAX_BYTES = 500 * 1024 * 1024;

/** Only archives. The bucket serves partner downloads, not arbitrary files. */
export const RAFEEQ_UPLOAD_CONTENT_TYPE = "application/zip";

/** Supabase's resumable endpoint wants exactly this, and says so. */
export const RAFEEQ_UPLOAD_CHUNK_BYTES = 6 * 1024 * 1024;

/**
 * Where a manually uploaded archive lives.
 *
 * `uploads/` is a sibling of `jobs/` and `artifacts/`, so nothing here can
 * collide with a generated package. The content hash is in the path, which
 * makes the destination a function of the BYTES: re-uploading the same archive
 * resumes to the same object, while a different archive can never land on top
 * of one already there — even under the same filename on the same day.
 */
export function rafeeqUploadObjectPath(sha256: string, filename: string, dayIso: string): string {
  const day = /^\d{4}-\d{2}-\d{2}/.test(dayIso) ? dayIso.slice(0, 10) : "0000-00-00";
  return `uploads/${day}/${sha256.slice(0, 16)}/${sanitizeUploadFilename(filename)}`;
}

/**
 * A filesystem- and URL-safe filename that still reads as itself. The name
 * travels to Rafeeq in the download's Content-Disposition, so it is preserved
 * rather than replaced by an id.
 */
export function sanitizeUploadFilename(filename: string): string {
  const base = String(filename ?? "").split(/[\\/]/).pop() ?? "";
  const safe = base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-{2,}/g, "-").replace(/^[-.]+/, "");
  return safe === "" ? "archive.zip" : safe.slice(0, 120);
}

export type RafeeqUploadBlock =
  | "not_a_zip"
  | "empty_file"
  | "too_large"
  | "sha256_malformed"
  | "size_mismatch"
  | "sha256_mismatch"
  | "object_missing";

export const RAFEEQ_UPLOAD_BLOCK_AR: Record<RafeeqUploadBlock, string> = {
  not_a_zip: "الملف ليس أرشيف ZIP — لا يُقبل هنا سوى أرشيف الحزمة.",
  empty_file: "الملف فارغ.",
  too_large: "حجم الملف يتجاوز الحد المسموح للرفع.",
  sha256_malformed: "بصمة SHA-256 غير صالحة.",
  size_mismatch: "حجم الملف المرفوع لا يطابق الحجم المعلن — لم يكتمل الرفع.",
  sha256_mismatch: "محتوى الملف المرفوع لا يطابق الأصل.",
  object_missing: "لا يوجد ملف على هذا المسار في التخزين.",
};

export interface RafeeqUploadRequest {
  filename: string;
  bytes: number;
  sha256: string;
}

const SHA256_RE = /^[0-9a-f]{64}$/;

/**
 * Everything that can be judged BEFORE a single byte moves. A refused upload
 * never reaches storage, so a rejected file cannot leave a partial object
 * behind for someone to find later and mistake for a package.
 */
export function verifyRafeeqUploadRequest(req: RafeeqUploadRequest): RafeeqUploadBlock[] {
  const blocks: RafeeqUploadBlock[] = [];
  if (!/\.zip$/i.test(String(req.filename ?? ""))) blocks.push("not_a_zip");
  if (!Number.isFinite(req.bytes) || req.bytes <= 0) blocks.push("empty_file");
  else if (req.bytes > RAFEEQ_UPLOAD_MAX_BYTES) blocks.push("too_large");
  if (!SHA256_RE.test(String(req.sha256 ?? "").toLowerCase())) blocks.push("sha256_malformed");
  return blocks;
}

/**
 * What the owner's browser needs to upload directly, and nothing more.
 *
 * `token` is a signed upload credential scoped to ONE object path. It is not
 * the service key and cannot read, list, delete, or write anywhere else.
 */
export interface RafeeqUploadTicket {
  bucket: string;
  objectPath: string;
  /** scoped, single-path upload credential — sent as the x-signature header */
  token: string;
  /** Supabase's resumable endpoint */
  endpoint: string;
  /** the public, browser-safe project key */
  apiKey: string;
  chunkBytes: number;
  contentType: string;
  expectedBytes: number;
  expectedSha256: string;
}

/**
 * Did the bytes that landed match the bytes that were promised?
 *
 * `storedBytes === null` means the object is not there at all, which is a
 * different failure from a short object and is reported as one: the first says
 * the upload never completed, the second says it completed wrong.
 */
export function verifyRafeeqUploadedObject(
  storedBytes: number | null,
  expectedBytes: number,
  downloadedSha256?: string | null,
  expectedSha256?: string | null,
): RafeeqUploadBlock[] {
  const blocks: RafeeqUploadBlock[] = [];
  if (storedBytes === null) return ["object_missing"];
  if (storedBytes !== expectedBytes) blocks.push("size_mismatch");
  // The hash is compared only when the caller actually read the bytes back.
  // Absent evidence is never counted as a pass.
  if (typeof downloadedSha256 === "string" && typeof expectedSha256 === "string"
    && downloadedSha256.toLowerCase() !== expectedSha256.toLowerCase()) {
    blocks.push("sha256_mismatch");
  }
  return blocks;
}

/** The download link the owner hands to Rafeeq. */
export interface RafeeqUploadLinkDTO {
  url: string;
  expiresAtIso: string;
  filename: string;
  objectPath: string;
  bytes: number;
  sha256: string;
}
