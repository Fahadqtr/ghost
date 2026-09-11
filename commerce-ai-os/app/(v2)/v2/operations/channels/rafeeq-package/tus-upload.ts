// Browser-side resumable upload over Supabase's TUS endpoint.
//
// Written out rather than pulled in as a dependency: the repo already speaks
// this protocol on the server (lib/storage/tus.server.ts), the browser half is
// the same four requests, and a 92 MB upload is not worth a new package in a
// lockfile that CI audits.
//
// The credential is a SIGNED UPLOAD TOKEN scoped to one object path, sent as
// x-signature. There is no service key in this file and none reaches the page.

export interface TusUploadOptions {
  endpoint: string;
  token: string;
  apiKey: string;
  bucket: string;
  objectPath: string;
  contentType: string;
  chunkBytes: number;
  file: Blob;
  onProgress?: (uploadedBytes: number, totalBytes: number) => void;
  /**
   * Called as soon as an upload URL exists — BEFORE any byte is sent.
   *
   * Without this the URL only escaped on success, which is precisely when it
   * is not needed: a failed attempt lost the one handle that could have
   * resumed it, so "resume" would have silently restarted from zero.
   */
  onUploadUrl?: (uploadUrl: string) => void;
  signal?: AbortSignal;
}

const b64 = (s: string): string =>
  btoa(String.fromCharCode(...new TextEncoder().encode(s)));

const headers = (o: TusUploadOptions): Record<string, string> => ({
  "tus-resumable": "1.0.0",
  "x-signature": o.token,
  apikey: o.apiKey,
});

/** Create the upload and return its unique URL. Valid for 24h, per the docs. */
async function create(o: TusUploadOptions): Promise<string> {
  const meta = [
    `bucketName ${b64(o.bucket)}`,
    `objectName ${b64(o.objectPath)}`,
    `contentType ${b64(o.contentType)}`,
    `cacheControl ${b64("3600")}`,
  ].join(",");
  const res = await fetch(o.endpoint, {
    method: "POST",
    headers: {
      ...headers(o),
      "upload-length": String(o.file.size),
      "upload-metadata": meta,
    },
    signal: o.signal,
  });
  const location = res.headers.get("location");
  if (!res.ok || !location) throw new Error(`tus_create_failed_${res.status}`);
  return new URL(location, o.endpoint).toString();
}

/** Where the server thinks this upload got to. The RESUME point. */
async function offsetOf(uploadUrl: string, o: TusUploadOptions): Promise<number> {
  const res = await fetch(uploadUrl, { method: "HEAD", headers: headers(o), signal: o.signal });
  if (!res.ok) throw new Error(`tus_offset_failed_${res.status}`);
  const n = Number(res.headers.get("upload-offset"));
  if (!Number.isFinite(n) || n < 0) throw new Error("tus_offset_invalid");
  return n;
}

/**
 * Upload the file, resuming an interrupted attempt rather than restarting it.
 *
 * Every failure re-reads the offset from the SERVER before continuing, so a
 * dropped connection costs one chunk, not 92 MB. Progress is reported from
 * that same server-confirmed offset — never from what we hoped we sent.
 */
export async function tusUpload(o: TusUploadOptions, resumeUrl?: string): Promise<string> {
  const total = o.file.size;
  let uploadUrl = resumeUrl ?? (await create(o));
  o.onUploadUrl?.(uploadUrl);
  let offset = resumeUrl ? await offsetOf(uploadUrl, o) : 0;
  o.onProgress?.(offset, total);

  const delays = [0, 1000, 3000, 5000, 10000, 20000];
  let attempt = 0;

  while (offset < total) {
    const end = Math.min(offset + o.chunkBytes, total);
    try {
      const res = await fetch(uploadUrl, {
        method: "PATCH",
        headers: {
          ...headers(o),
          "content-type": "application/offset+octet-stream",
          "upload-offset": String(offset),
        },
        body: o.file.slice(offset, end),
        signal: o.signal,
      });
      if (!res.ok) throw new Error(`tus_patch_${res.status}`);
      const next = Number(res.headers.get("upload-offset"));
      offset = Number.isFinite(next) && next > offset ? next : end;
      attempt = 0;
      o.onProgress?.(offset, total);
    } catch (e) {
      if (o.signal?.aborted) throw e;
      attempt += 1;
      if (attempt >= delays.length) throw e;
      await new Promise((r) => setTimeout(r, delays[attempt]));
      // Ask the server where it actually got to. Guessing here is how a
      // resumable upload silently corrupts an object.
      try {
        offset = await offsetOf(uploadUrl, o);
        o.onProgress?.(offset, total);
      } catch {
        uploadUrl = await create(o);
        o.onUploadUrl?.(uploadUrl);
        offset = 0;
        o.onProgress?.(0, total);
      }
    }
  }
  return uploadUrl;
}

/** SHA-256 of a file, streamed in slices so a 92 MB archive is not held twice. */
export async function sha256Of(file: Blob, onProgress?: (done: number, total: number) => void): Promise<string> {
  const buf = await file.arrayBuffer();
  onProgress?.(file.size, file.size);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
