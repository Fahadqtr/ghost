// SUPABASE RESUMABLE (TUS) — the wire contract, in one place (PURE).
//
// There are two callers of this protocol and they authenticate differently:
// the server uploads with a service-role key, and the owner's BROWSER uploads
// with a scoped signed token. What must NOT differ is the header set, and it
// did: the browser client was written separately and shipped without
// `Authorization` and without `x-upsert`, which is how an upload that worked
// on the server returned 403 from a page.
//
// So the headers live here, the auth material is a parameter, and both callers
// are the same implementation with different credentials.
//
// No I/O, no environment reads, no "server-only": this module is imported by
// client code, so it must never be able to carry a secret.

export const TUS_RESUMABLE_VERSION = "1.0.0";

/** Supabase requires exactly this chunk size for resumable uploads. */
export const TUS_CHUNK_BYTES = 6 * 1024 * 1024;

export const TUS_PATCH_CONTENT_TYPE = "application/offset+octet-stream";

/** The resumable endpoint for a project URL. */
export function tusEndpoint(supabaseUrl: string): string {
  return `${supabaseUrl.replace(/\/$/, "")}/storage/v1/upload/resumable`;
}

export interface TusAuth {
  /**
   * The bearer token for the `Authorization` header.
   *
   * Storage authorizes on this. Omitting it does not make a request
   * "unauthenticated but signed" — it makes it anonymous, and an anonymous
   * write to a private bucket is refused with 403 before the signature is
   * ever considered.
   */
  authToken: string;
  /** The project key. Public by design in a browser. */
  apiKey: string;
  /**
   * A signed upload token scoped to ONE object path, when the caller has no
   * privileged key of its own. This is what authorizes the write without the
   * service key ever reaching the browser.
   */
  signature?: string | null;
}

/**
 * The headers EVERY request of a resumable upload carries — create, HEAD and
 * patch alike.
 *
 * STEP 85J is why `x-upsert` is here rather than on the create call alone:
 * Storage defers the duplicate check to the write, so creating returned 201
 * while every PATCH came back 409 against an object that already existed. Zero
 * bytes were accepted, and the resume had nothing to resume. That cost two
 * production publishes to find once; it is not being rediscovered per caller.
 */
export function tusUploadHeaders(auth: TusAuth): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.authToken}`,
    apikey: auth.apiKey,
    "tus-resumable": TUS_RESUMABLE_VERSION,
    "x-upsert": "true",
  };
  if (typeof auth.signature === "string" && auth.signature !== "") {
    headers["x-signature"] = auth.signature;
  }
  return headers;
}

/** Base64 of UTF-8 text, without Buffer or btoa — the same in both runtimes. */
export function tusBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += A[b0 >> 2];
    out += A[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? "=" : A[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? "=" : A[b2 & 63];
  }
  return out;
}

export interface TusObjectMetadata {
  bucket: string;
  objectPath: string;
  contentType: string;
  cacheControl?: string;
}

/** The `upload-metadata` value naming the destination of this upload. */
export function tusUploadMetadata(meta: TusObjectMetadata): string {
  return [
    `bucketName ${tusBase64(meta.bucket)}`,
    `objectName ${tusBase64(meta.objectPath)}`,
    `contentType ${tusBase64(meta.contentType)}`,
    `cacheControl ${tusBase64(meta.cacheControl ?? "3600")}`,
  ].join(",");
}
