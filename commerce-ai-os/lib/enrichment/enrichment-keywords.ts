// CH.6E — keyword normalization / dedupe (PURE).
//
// Keywords are stored as a comma-separated string on products.keywords_en /
// keywords_ar. This module parses, normalizes and de-duplicates keyword lists and
// detects the common WEAK case where a whole description sentence was dumped into
// the keywords field instead of real search terms.
//
// PURE: no imports. node:test loads it directly.

const MAX_KEYWORDS = 20;

/** Split a stored keyword string into raw tokens (comma-separated). */
export function parseKeywords(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  return raw.split(",").map((t) => t.trim()).filter((t) => t !== "");
}

/**
 * Normalize + dedupe a token list: trim, collapse internal whitespace, drop
 * empties, dedupe case-insensitively (first casing wins), and cap the count.
 * Order is preserved. Never invents tokens.
 */
export function normalizeKeywordList(tokens: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of tokens) {
    const v = String(t ?? "").replace(/\s+/g, " ").trim();
    if (v === "") continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
    if (out.length >= MAX_KEYWORDS) break;
  }
  return out;
}

/** Join a normalized token list into the stored comma-separated form. */
export function keywordsToString(tokens: readonly string[]): string {
  return normalizeKeywordList(tokens).join(", ");
}

/** Normalize a raw stored keyword string end-to-end. */
export function normalizeKeywords(raw: unknown): string {
  return keywordsToString(parseKeywords(raw));
}

/**
 * Heuristic: does this text read as PROSE rather than a keyword list? A real
 * keyword list is short comma-separated tokens; a dumped description sentence is
 * long, comma-sparse, and sentence-punctuated. Used to flag WEAK keywords.
 */
export function looksLikeProse(raw: unknown): boolean {
  const s = String(raw ?? "").trim();
  if (s === "") return false;
  const tokens = parseKeywords(s);
  const commaCount = (s.match(/,/g) ?? []).length;
  // A single very long "token" with sentence punctuation, or long text with too
  // few commas, is prose, not keywords.
  const hasSentence = /[.!?؟]/.test(s) || /\b(and|with|the|your|this)\b/i.test(s);
  if (commaCount < 2 && s.length > 60) return true;
  if (hasSentence && tokens.some((t) => t.length > 40)) return true;
  const avgLen = tokens.length ? tokens.reduce((a, t) => a + t.length, 0) / tokens.length : 0;
  return avgLen > 40; // average token far longer than a keyword
}
