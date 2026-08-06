// Duplicate detection for the AI product creator (Phase UI.5). Pure, no
// imports, no I/O — the caller loads the identity snapshot (products +
// variants) and this module decides none / similar / exact.
//
// Matching is on NORMALIZED identity: lowercase, symbols and spaces stripped,
// Arabic-Indic digits unified to Latin, and volume words unified (مل / ML /
// ml. -> ml). Save is blocked only on a REAL match (same sku, same barcode,
// or the same normalized brand+name+size+shade identity) — "similar" warns
// and never blocks.

export interface IdentityRow {
  id: string;
  kind: "product" | "variant";
  sku: string | null;
  barcode: string | null;
  nameEn: string | null;
  nameAr: string | null;
  size: string | null;
  color: string | null;
}

export interface DuplicateCandidate {
  sku: string;
  barcodes: string[];
  brand: string;
  nameEn: string;
  nameAr: string;
  size: string;
  shade: string;
}

export type DuplicateLevel = "none" | "similar" | "exact";

export interface DuplicateMatch {
  id: string;
  kind: "product" | "variant";
  /** Fixed vocabulary — rendered directly, so no raw field values leak. */
  reason: "same_sku" | "same_barcode" | "same_identity" | "similar_name";
  /** The matched row's display name (catalog data the user can already see). */
  label: string;
}

export interface DuplicateReport {
  level: DuplicateLevel;
  matches: DuplicateMatch[];
}

const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";

/** lowercase, unified digits/volumes, letters+digits only. */
export function normalizeIdentity(value: unknown): string {
  if (typeof value !== "string") return "";
  let s = value.trim().toLowerCase();
  let out = "";
  for (const ch of s) {
    const d = ARABIC_DIGITS.indexOf(ch);
    out += d >= 0 ? String(d) : ch;
  }
  // NOTE: \b is ASCII-only in JS, so Arabic words need explicit letter
  // lookarounds — مل\b would never match after an Arabic letter boundary.
  s = out
    .replace(/(?<!\p{L})(?:مل|ملل)(?!\p{L})/gu, "ml")
    .replace(/(?<!\p{L})millilit(?:er|re)s?(?!\p{L})/gu, "ml")
    .replace(/\bml\.?\b/g, "ml");
  // Keep letters (any script) and digits; drop symbols, punctuation, spaces.
  return s.replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Tokenized form for similarity (words of letters/digits, normalized). */
export function identityTokens(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value
    .split(/[^\p{L}\p{N}]+/u)
    .map((t) => normalizeIdentity(t))
    .filter((t) => t.length > 1);
}

function tokenOverlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  let hit = 0;
  for (const t of new Set(a)) if (setB.has(t)) hit++;
  return hit / Math.min(new Set(a).size, setB.size);
}

function rowLabel(row: IdentityRow): string {
  return row.nameAr || row.nameEn || row.sku || "منتج في الكتالوج";
}

/** The candidate's composite identity: brand+name+size+shade, normalized. */
export function candidateIdentity(c: DuplicateCandidate): string {
  return normalizeIdentity(`${c.brand} ${c.nameEn} ${c.size} ${c.shade}`);
}

function rowIdentity(row: IdentityRow): string {
  return normalizeIdentity(`${row.nameEn ?? ""} ${row.size ?? ""} ${row.color ?? ""}`);
}

const SIMILAR_THRESHOLD = 0.8;

/**
 * Compare the candidate against every existing row. Exact beats similar; the
 * match list is capped so the review screen stays readable.
 */
export function findDuplicates(
  candidate: DuplicateCandidate,
  rows: readonly IdentityRow[],
  maxMatches = 5,
): DuplicateReport {
  const wantSkus = new Set<string>();
  const mainSku = normalizeIdentity(candidate.sku);
  if (mainSku) wantSkus.add(mainSku);
  const wantBarcodes = new Set(candidate.barcodes.map((b) => (b ?? "").trim()).filter(Boolean));
  const wantIdentity = candidateIdentity(candidate);
  const wantTokens = identityTokens(`${candidate.brand} ${candidate.nameEn} ${candidate.nameAr}`);

  const exact: DuplicateMatch[] = [];
  const similar: DuplicateMatch[] = [];

  for (const row of rows) {
    const rowSku = normalizeIdentity(row.sku ?? "");
    if (rowSku && wantSkus.has(rowSku)) {
      exact.push({ id: row.id, kind: row.kind, reason: "same_sku", label: rowLabel(row) });
      continue;
    }
    const rowBarcode = (row.barcode ?? "").trim();
    if (rowBarcode && wantBarcodes.has(rowBarcode)) {
      exact.push({ id: row.id, kind: row.kind, reason: "same_barcode", label: rowLabel(row) });
      continue;
    }
    const ident = rowIdentity(row);
    if (wantIdentity.length > 6 && ident.length > 6 && ident === wantIdentity) {
      exact.push({ id: row.id, kind: row.kind, reason: "same_identity", label: rowLabel(row) });
      continue;
    }
    if (wantTokens.length >= 2) {
      const rowTokens = identityTokens(`${row.nameEn ?? ""} ${row.nameAr ?? ""}`);
      if (tokenOverlap(wantTokens, rowTokens) >= SIMILAR_THRESHOLD) {
        similar.push({ id: row.id, kind: row.kind, reason: "similar_name", label: rowLabel(row) });
      }
    }
  }

  if (exact.length > 0) return { level: "exact", matches: exact.slice(0, maxMatches) };
  if (similar.length > 0) return { level: "similar", matches: similar.slice(0, maxMatches) };
  return { level: "none", matches: [] };
}
