// CH.6D — Snoonu barcode normalization (PURE).
//
// Normalizes a raw barcode token from deterministic Snoonu evidence and decides
// whether it is syntactically valid for the Catalog domain. It NEVER invents or
// coerces: leading zeros are preserved exactly (the value is treated as a string,
// never Number()'d), and validity reuses the CANONICAL catalog validators —
// isValidEan13 (strict house type) and isLooseBarcode (6–14 digits, the import
// shape). No second validator is introduced here.
//
// PURE: imports only the canonical pure validators (relative, no @/). node:test
// loads it directly.

import { isValidEan13 } from "../../../products/barcode-ean13.ts";
import { isLooseBarcode } from "../../../products/variant-validate.ts";

/**
 * Normalize a raw barcode token to its canonical string form, or null when it
 * carries no value. Trims surrounding whitespace and preserves the digits (and
 * any leading zeros) exactly — it does NOT strip, pad, or numerically coerce.
 * A non-string (e.g. a numeric spreadsheet cell) is stringified WITHOUT going
 * through Number(), so "007" stays "007"; a genuine number that already lost its
 * leading zeros upstream cannot be recovered here and is left as-is (its validity
 * is judged by the caller).
 */
export function normalizeBarcode(raw: unknown): string | null {
  if (raw == null) return null;
  const s = (typeof raw === "string" ? raw : String(raw)).trim();
  return s === "" ? null : s;
}

/** True when the internal barcode field is empty (NULL / blank). */
export function isBarcodeEmpty(raw: unknown): boolean {
  return normalizeBarcode(raw) === null;
}

/**
 * Syntactic validity for a source barcode, using ONLY the catalog's canonical
 * validators: a strict EAN-13, or the loose 6–14-digit import shape. Anything
 * else (letters, wrong length, punctuation) is invalid — never coerced.
 */
export function isSyntacticallyValidBarcode(value: string): boolean {
  const v = value.trim();
  return isValidEan13(v) || isLooseBarcode(v);
}
