// Duplicate detection for the AI product creator (Phase UI.5, card revision).
// Pure, no imports, no I/O — the caller loads the identity snapshot (products
// + variants) and this module aggregates matches BY PRODUCT: one entry per
// catalog product, its reasons merged ("اسم مشابه · نفس البراند · نفس الحجم"
// instead of five repeated lines), sorted strongest-first. A variant match
// rolls up into its PARENT product via IdentityRow.productId.
//
// Matching is on NORMALIZED identity: lowercase, symbols and spaces stripped,
// Arabic-Indic digits unified to Latin, and volume words unified (مل / ML /
// ml. -> ml). Save is blocked only on a REAL match (same sku, same barcode,
// or the same normalized brand+name+size+shade identity) — "similar" warns
// and never blocks. Secondary signals (brand / size / shade) only qualify a
// product when the name is similar too, or when brand + size/shade agree —
// sharing a size alone is noise, not similarity.

export interface IdentityRow {
  id: string;
  kind: "product" | "variant";
  /** The catalog PRODUCT this row belongs to: own id for products, the
   *  parent product id for variants. Aggregation key. */
  productId: string;
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

/** Fixed vocabulary — rendered via fixed labels, never raw field values. */
export type DuplicateReason =
  | "same_sku"
  | "same_barcode"
  | "same_identity"
  | "similar_name"
  | "same_brand"
  | "same_size"
  | "same_shade";

const EXACT_REASONS: ReadonlySet<DuplicateReason> = new Set(["same_sku", "same_barcode", "same_identity"]);

const REASON_SCORE: Record<DuplicateReason, number> = {
  same_sku: 100,
  same_barcode: 100,
  same_identity: 100,
  similar_name: 40,
  same_brand: 20,
  same_size: 15,
  same_shade: 15,
};

/** One catalog product in the report: reasons merged, strongest first. */
export interface DuplicateProductMatch {
  productId: string;
  level: "exact" | "similar";
  reasons: DuplicateReason[];
  score: number;
}

export interface DuplicateReport {
  level: DuplicateLevel;
  /** Deduped by productId, ordered exact-first then by descending score. */
  matches: DuplicateProductMatch[];
  /** Matches found BEFORE the cap — the UI can say "and N more". */
  total: number;
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

/** The candidate's composite identity: brand+name+size+shade, normalized. */
export function candidateIdentity(c: DuplicateCandidate): string {
  return normalizeIdentity(`${c.brand} ${c.nameEn} ${c.size} ${c.shade}`);
}

function rowIdentity(row: IdentityRow): string {
  return normalizeIdentity(`${row.nameEn ?? ""} ${row.size ?? ""} ${row.color ?? ""}`);
}

const SIMILAR_THRESHOLD = 0.8;
const DEFAULT_MAX_MATCHES = 12;

/**
 * Compare the candidate against every existing row, then AGGREGATE by catalog
 * product: one match per productId with the union of its rows' reasons.
 */
export function findDuplicates(
  candidate: DuplicateCandidate,
  rows: readonly IdentityRow[],
  maxMatches = DEFAULT_MAX_MATCHES,
): DuplicateReport {
  const wantSku = normalizeIdentity(candidate.sku);
  const wantBarcodes = new Set(candidate.barcodes.map((b) => (b ?? "").trim()).filter(Boolean));
  const wantIdentity = candidateIdentity(candidate);
  const wantTokens = identityTokens(`${candidate.brand} ${candidate.nameEn} ${candidate.nameAr}`);
  const wantBrand = normalizeIdentity(candidate.brand);
  const wantSize = normalizeIdentity(candidate.size);
  const wantShade = normalizeIdentity(candidate.shade);

  const buckets = new Map<string, Set<DuplicateReason>>();

  for (const row of rows) {
    if (typeof row.productId !== "string" || row.productId.length === 0) continue;
    const reasons: DuplicateReason[] = [];

    const rowSku = normalizeIdentity(row.sku ?? "");
    if (wantSku && rowSku && rowSku === wantSku) reasons.push("same_sku");
    const rowBarcode = (row.barcode ?? "").trim();
    if (rowBarcode && wantBarcodes.has(rowBarcode)) reasons.push("same_barcode");
    const ident = rowIdentity(row);
    if (wantIdentity.length > 6 && ident.length > 6 && ident === wantIdentity) reasons.push("same_identity");

    const rowTokens = identityTokens(`${row.nameEn ?? ""} ${row.nameAr ?? ""}`);
    const nameSimilar = wantTokens.length >= 2 && tokenOverlap(wantTokens, rowTokens) >= SIMILAR_THRESHOLD;
    const brandSame = wantBrand.length > 1 && rowTokens.includes(wantBrand);
    const sizeSame = wantSize.length > 0 && normalizeIdentity(row.size ?? "") === wantSize;
    const shadeSame = wantShade.length > 1 && normalizeIdentity(row.color ?? "") === wantShade;

    // Secondary signals qualify a product only alongside a real resemblance:
    // similar name, or brand + (size|shade). Size/shade alone is noise.
    const qualifies = reasons.length > 0 || nameSimilar || (brandSame && (sizeSame || shadeSame));
    if (!qualifies) continue;

    if (nameSimilar) reasons.push("similar_name");
    if (brandSame) reasons.push("same_brand");
    if (sizeSame) reasons.push("same_size");
    if (shadeSame) reasons.push("same_shade");

    let bucket = buckets.get(row.productId);
    if (!bucket) {
      bucket = new Set<DuplicateReason>();
      buckets.set(row.productId, bucket);
    }
    for (const r of reasons) bucket.add(r);
  }

  const matches: DuplicateProductMatch[] = [];
  for (const [productId, reasonSet] of buckets) {
    // Stable reason order: strongest first, matching REASON_SCORE weights.
    const reasons = (Object.keys(REASON_SCORE) as DuplicateReason[]).filter((r) => reasonSet.has(r));
    const score = reasons.reduce((sum, r) => sum + REASON_SCORE[r], 0);
    const level: "exact" | "similar" = reasons.some((r) => EXACT_REASONS.has(r)) ? "exact" : "similar";
    matches.push({ productId, level, reasons, score });
  }

  matches.sort((a, b) => {
    if (a.level !== b.level) return a.level === "exact" ? -1 : 1;
    return b.score - a.score;
  });

  const total = matches.length;
  const capped = matches.slice(0, maxMatches);
  const level: DuplicateLevel = capped.some((m) => m.level === "exact") ? "exact" : total > 0 ? "similar" : "none";
  return { level, matches: capped, total };
}
