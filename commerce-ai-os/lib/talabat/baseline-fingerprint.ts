// TALABAT BASELINE — content fingerprint (PURE).
//
// Lives outside lib/export on purpose. The INT.2A guard holds that the export
// foundation performs no writes, and enforces it by scanning for `.update(` —
// which a hash builder also uses. Rather than weaken an architectural guard to
// accommodate a hash, the hashing lives here, where it is still pure and
// directly unit-testable.

import { createHash } from "node:crypto";

/**
 * A content hash of the uploaded Talabat export.
 *
 * Content, not filename or timestamp: re-uploading the identical export keeps
 * the same fingerprint (so already-generated artifacts stay valid), while a
 * genuinely different export changes it and invalidates them.
 */
export function baselineFingerprint(bytes: Uint8Array): string {
  return `b1.${createHash("sha256").update(bytes).digest("hex").slice(0, 32)}`;
}
