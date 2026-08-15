// CH.6B — fetched-image safety validation (PURE).
//
// Before importing, prove the fetched bytes are actually a supported image and
// not an HTML login/error page masquerading as one. Pure: takes already-read
// response metadata + the first bytes; makes no network calls.
//
// PURE: no imports. node:test loads it directly.

export const SUPPORTED_IMAGE_MIME = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"] as const;

export interface ImageSafetyInput {
  contentType: string | null;
  byteLength: number;
  /** First bytes of the body (magic-number sniff). */
  headBytes: Uint8Array;
  width?: number | null;
  height?: number | null;
}

export interface ImageSafetyResult {
  ok: boolean;
  reason?: string;
}

export interface ImageSafetyLimits {
  minBytes: number;
  maxBytes: number;
  minDimension: number;
}

export const DEFAULT_IMAGE_LIMITS: ImageSafetyLimits = { minBytes: 512, maxBytes: 15 * 1024 * 1024, minDimension: 100 };

const startsWith = (b: Uint8Array, sig: number[]): boolean => sig.every((v, i) => b[i] === v);

/** Magic-number image sniff (independent of the declared content-type). */
export function looksLikeImage(head: Uint8Array): boolean {
  if (head.length < 4) return false;
  if (startsWith(head, [0xff, 0xd8, 0xff])) return true; //                     JPEG
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47])) return true; //              PNG
  if (startsWith(head, [0x47, 0x49, 0x46, 0x38])) return true; //              GIF
  if (head.length >= 12 && startsWith(head, [0x52, 0x49, 0x46, 0x46]) &&
      head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50) return true; // WEBP (RIFF….WEBP)
  if (head.length >= 12 && head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70) return true; // AVIF/HEIF (ftyp)
  return false;
}

/** True when the head looks like an HTML/login/error page, not an image. */
export function looksLikeHtml(head: Uint8Array): boolean {
  // Skip leading whitespace, then check for '<'
  let i = 0;
  while (i < head.length && (head[i] === 0x20 || head[i] === 0x09 || head[i] === 0x0a || head[i] === 0x0d || head[i] === 0xef || head[i] === 0xbb || head[i] === 0xbf)) i++;
  return head[i] === 0x3c; // '<'  (covers <!doctype, <html, <?xml…)
}

export function validateFetchedImage(input: ImageSafetyInput, limits: ImageSafetyLimits = DEFAULT_IMAGE_LIMITS): ImageSafetyResult {
  const ct = (input.contentType ?? "").split(";")[0].trim().toLowerCase();
  if (looksLikeHtml(input.headBytes)) return { ok: false, reason: "response is an HTML page, not an image" };
  if (!ct.startsWith("image/") || !SUPPORTED_IMAGE_MIME.includes(ct as (typeof SUPPORTED_IMAGE_MIME)[number])) {
    return { ok: false, reason: `unsupported content-type: ${ct || "none"}` };
  }
  if (!looksLikeImage(input.headBytes)) return { ok: false, reason: "bytes are not a recognized image format" };
  if (input.byteLength < limits.minBytes) return { ok: false, reason: "image too small" };
  if (input.byteLength > limits.maxBytes) return { ok: false, reason: "image too large" };
  if (input.width != null && input.height != null && (input.width < limits.minDimension || input.height < limits.minDimension)) {
    return { ok: false, reason: "image dimensions below minimum" };
  }
  return { ok: true };
}
