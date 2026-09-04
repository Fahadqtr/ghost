// STEP 64 — the Talabat category registry + resolver (PURE).
//
// Reconstructed in STEP 63 from the owner's historical Talabat file
// (Talabat_Pharmacy_Inventory_L3_Filled, 1146 rows, 17 distinct
// `category::en_QA` values, 0 blank). Every one of the 16 canonical catalog
// categories was observed VERBATIM in that file, so nothing here is invented:
// each output string is the exact byte sequence Talabat itself used.
//
// Talabat gave us category STRINGS, not numeric ids — so this registry carries
// no id field. A Talabat category id is never fabricated.
//
// INPUT-TOLERANT, OUTPUT-EXACT
//   in : "Toys" | "✨Toys"                        out: "✨Toys"
//   in : "Women's Essentials" | "Women’s Essentials"  out: "Women’s Essentials"
//   in : anything else                            out: FAIL CLOSED (unresolved)
// Unknown free text is NEVER passed through — a row that cannot resolve is
// blocked upstream rather than shipped with a guessed or raw category.
//
// Structural pattern borrowed from lib/export/rafeeq/native-template.ts. No
// Rafeeq id, alias or assumption is copied: Rafeeq folds U+2019 to ASCII on
// OUTPUT because its own workbook spells it that way; Talabat is the mirror
// image and must EMIT U+2019.

/** One live Talabat category. Strings only — Talabat exposes no ids to us. */
export interface TalabatNativeCategory {
  /**
   * The exact `category::en_QA` value observed in the historical Talabat file.
   * Emitted byte-for-byte; never normalized, never re-cased.
   */
  talabat: string;
  /** rows carrying this value in the historical file (STEP 63 evidence). */
  evidenceRows: number;
}

/**
 * The 16 PERMANENT canonical → Talabat category outputs (owner-authorized,
 * STEP 64). Keyed by the canonical catalog category name, apostrophe-folded —
 * see `foldKey`.
 *
 * `🌙 Eid Specials` is deliberately ABSENT: it is a temporary/campaign
 * category (19 historical rows) and the owner ruled it must never be a
 * permanent canonical mapping. See TALABAT_CAMPAIGN_CATEGORIES.
 */
export const TALABAT_NATIVE_CATEGORIES: Record<string, TalabatNativeCategory> = {
  "Face Care": { talabat: "Face Care", evidenceRows: 296 },
  "Lashes & Nails": { talabat: "Lashes & Nails", evidenceRows: 183 },
  "Beauty Accessories": { talabat: "Beauty Accessories", evidenceRows: 156 },
  "Makeup": { talabat: "Makeup", evidenceRows: 112 },
  "Hair Care": { talabat: "Hair Care", evidenceRows: 109 },
  "Body Care": { talabat: "Body Care", evidenceRows: 58 },
  "Electronics": { talabat: "Electronics", evidenceRows: 44 },
  // canonical stores U+2019; Talabat used U+2019 too — emit it unchanged.
  "Women's Essentials": { talabat: "Women’s Essentials", evidenceRows: 33 },
  "Dental Care": { talabat: "Dental Care", evidenceRows: 26 },
  "Rhode Products Section": { talabat: "Rhode Products Section", evidenceRows: 24 },
  "Masks": { talabat: "Masks", evidenceRows: 24 },
  "Summer And Camping Supplies": { talabat: "Summer And Camping Supplies", evidenceRows: 21 },
  "Thailand Products": { talabat: "Thailand Products", evidenceRows: 12 },
  // the ONLY decorated output: U+2728 SPARKLES immediately followed by "Toys",
  // no separating space. lib/constants.ts records the reverse migration
  // ("✨Toys cleaned to Toys 2026-06-09") — this restores it on export only.
  "Toys": { talabat: "✨Toys", evidenceRows: 12 },
  "Beauty Bundle": { talabat: "Beauty Bundle", evidenceRows: 10 },
  "Sun Protection": { talabat: "Sun Protection", evidenceRows: 7 },
};

/**
 * Historical Talabat categories that are TEMPORARY / CAMPAIGN and must never
 * become a permanent canonical mapping (owner decision, STEP 64). Kept as
 * documented evidence so a future reader cannot mistake the omission for an
 * oversight — and so a test can prove it is not in the registry.
 */
export const TALABAT_CAMPAIGN_CATEGORIES: readonly string[] = ["🌙 Eid Specials"];

/**
 * Decorated / alternate INPUT spellings accepted for a canonical key. Exact
 * matches only — never fuzzy. These exist so a caller may hand us either the
 * canonical name or the Talabat-decorated form and still get the same exact
 * output.
 */
export const TALABAT_CATEGORY_INPUT_ALIASES: Record<string, string> = {
  "✨Toys": "Toys",
  "✨ Toys": "Toys",
};

/**
 * Deterministic key folding for LOOKUP ONLY (never applied to output):
 * trim, collapse internal whitespace, fold the typographic apostrophe to
 * ASCII. Canonical data stores "Women’s Essentials"; a caller may pass either
 * form. No case folding and no fuzzy matching — any other difference makes the
 * category unknown.
 */
function foldKey(name: string | null | undefined): string {
  return String(name ?? "").trim().replace(/\s+/g, " ").replace(/[’‘]/g, "'");
}

/** Why a category could not resolve. */
export type TalabatCategoryUnresolved = "missing" | "unknown";

export type TalabatCategoryResolution =
  | { ok: true; canonicalKey: string; category: string }
  | { ok: false; reason: TalabatCategoryUnresolved; input: string };

/**
 * Resolve a canonical category name to its EXACT Talabat output string.
 *
 * FAILS CLOSED — an empty value resolves to `missing`, anything not in the
 * registry (or its explicit input aliases) resolves to `unknown`. The caller
 * must block the row; it must never fall back to the raw input.
 */
export function resolveTalabatCategory(name: string | null | undefined): TalabatCategoryResolution {
  const input = String(name ?? "").trim();
  if (input === "") return { ok: false, reason: "missing", input };
  const folded = foldKey(input);
  const key = TALABAT_NATIVE_CATEGORIES[folded]
    ? folded
    : (TALABAT_CATEGORY_INPUT_ALIASES[input] ?? TALABAT_CATEGORY_INPUT_ALIASES[folded]);
  if (key === undefined || !TALABAT_NATIVE_CATEGORIES[key]) {
    return { ok: false, reason: "unknown", input };
  }
  return { ok: true, canonicalKey: key, category: TALABAT_NATIVE_CATEGORIES[key].talabat };
}

/**
 * The exact Talabat category string for a canonical name, or `undefined` when
 * it cannot be resolved. Convenience wrapper over resolveTalabatCategory —
 * callers that need the reason should use the resolver directly.
 */
export function talabatCategoryByCanonicalName(name: string | null | undefined): string | undefined {
  const r = resolveTalabatCategory(name);
  return r.ok ? r.category : undefined;
}

/** Every exact Talabat output string the registry can emit (16). */
export const TALABAT_OUTPUT_CATEGORIES: readonly string[] =
  Object.values(TALABAT_NATIVE_CATEGORIES).map((c) => c.talabat);
