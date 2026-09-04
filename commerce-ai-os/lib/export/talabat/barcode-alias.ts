// STEP 68 — the Talabat EXPORT-LOCAL barcode resolver (PURE).
//
// Canonical `product_variants.barcode` is NEVER modified. STEP 67 proved the
// 159 hyphenated variant barcodes are live Shopify identity: 159 active
// shopify:malikas ECL rows (identity_type = shopify_gid), 154 Shopify
// snapshots, 59 staff tasks. Changing them would desynchronise Shopify. So the
// transformation below exists ONLY in the Talabat output layer.
//
// THE RULE
//   A. a plain numeric barcode            -> preserved byte-for-byte
//        850055526181 -> 850055526181     (the 3 genuine manufacturer UPCs)
//   B. the EXACT synthetic canonical shape ^\d{13}-\d$ -> hyphen removed
//        8719783947424-1 -> 87197839474241
//   C. anything else                       -> FAIL CLOSED (never passed through)
//
// The value produced by rule B is a TALABAT EXPORT-LOCAL INTERNAL NUMERIC
// ALIAS. It is NOT a GTIN, NOT a GS1 barcode, NOT an EAN-14, and NOT a
// manufacturer barcode. It is simply the deterministic value written into
// Talabat's barcode field.
//
// Deterministic and stateless by design: the same canonical value always
// yields the same alias, so a regenerated package is byte-stable and no
// persisted mapping is required. (A randomly generated identifier would need
// one — which is why generateUniqueEan13Batch is deliberately NOT used here.)

/** The ONLY canonical shape eligible for the alias transformation. */
export const TALABAT_ALIAS_SOURCE_RE = /^\d{13}-\d$/;
/** A barcode already acceptable to emit unchanged (the certified 6–14 floor). */
export const TALABAT_PLAIN_NUMERIC_RE = /^\d{6,14}$/;

export type TalabatBarcodeKind = "genuine" | "alias";
export type TalabatBarcodeUnresolved = "missing" | "unsupported";

export type TalabatBarcodeResolution =
  | { ok: true; barcode: string; kind: TalabatBarcodeKind }
  | { ok: false; reason: TalabatBarcodeUnresolved; input: string };

/**
 * Resolve the barcode a Talabat row must carry.
 *
 * FAILS CLOSED. In particular a suffix of two or more digits (…-10) is NOT
 * eligible: removing its hyphen would yield 15 digits, a different shape than
 * the audited one. Such a value returns `unsupported` so the row is blocked
 * and reviewed, rather than silently emitting an unaudited identifier.
 */
export function resolveTalabatBarcode(raw: string | null | undefined): TalabatBarcodeResolution {
  const input = String(raw ?? "").trim();
  if (input === "") return { ok: false, reason: "missing", input };
  if (TALABAT_ALIAS_SOURCE_RE.test(input)) {
    return { ok: true, barcode: input.replace("-", ""), kind: "alias" };
  }
  if (TALABAT_PLAIN_NUMERIC_RE.test(input)) {
    return { ok: true, barcode: input, kind: "genuine" };
  }
  return { ok: false, reason: "unsupported", input };
}

/**
 * Reverse a 14-digit alias back to its canonical source value.
 *
 * Defined ONLY for the documented alias shape: 14 digits -> 13 digits + "-" +
 * the final digit. Returns undefined for anything else. Note this is the
 * inverse of rule B only — a genuine 14-digit manufacturer barcode would be
 * indistinguishable, which is why the current dataset (where every parent
 * barcode is 13 digits and no genuine variant barcode is 14) is what makes the
 * mapping unambiguous. Any future genuine 14-digit barcode must be reviewed.
 */
export function reverseTalabatBarcodeAlias(alias: string | null | undefined): string | undefined {
  const v = String(alias ?? "").trim();
  if (!/^\d{14}$/.test(v)) return undefined;
  return `${v.slice(0, 13)}-${v.slice(13)}`;
}

/** True when the value is the exact canonical shape eligible for aliasing. */
export function isTalabatAliasSource(raw: string | null | undefined): boolean {
  return TALABAT_ALIAS_SOURCE_RE.test(String(raw ?? "").trim());
}
