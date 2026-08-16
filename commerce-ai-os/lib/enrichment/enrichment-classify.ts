// CH.6E — deterministic content-quality classification (PURE).
//
// Classifies each enrichable field as MISSING / WEAK / GOOD using DETERMINISTIC
// rules only (never subjective AI scoring as the candidate trigger). MISSING is
// eligible for bulk apply; WEAK is generated but needs explicit selection; GOOD
// is left alone (§13).
//
// PURE: imports only pure siblings. node:test loads it.

import { ENRICHMENT_FIELDS, type EnrichmentField, fieldKind } from "./enrichment-fields.ts";
import { looksLikeProse, parseKeywords } from "./enrichment-keywords.ts";

export type Quality = "MISSING" | "WEAK" | "GOOD" | "NEEDS_REVIEW";

/** The authoritative catalog facts for one product (the ONLY generation input). */
export interface ProductFacts {
  productId: string;
  sku: string | null;
  nameEn: string | null;
  nameAr: string | null;
  descriptionEn: string | null;
  descriptionAr: string | null;
  keywordsEn: string | null;
  keywordsAr: string | null;
  brand: string | null;
  mainCategory: string | null;
  subCategory: string | null;
  productType: string | null;
  color: string | null;
  size: string | null;
  variantNames: string[];
  lifecycle: string | null;
}

const MIN_DESCRIPTION_LEN = 40;
const PLACEHOLDERS = new Set(["n/a", "na", "-", "--", ".", "..", "test", "asdf", "tbd", "todo", "none", "null", "xxx"]);

const blank = (v: string | null | undefined): boolean => String(v ?? "").trim() === "";

function fieldValue(facts: ProductFacts, f: EnrichmentField): string | null {
  switch (f) {
    case "keywords_en": return facts.keywordsEn;
    case "keywords_ar": return facts.keywordsAr;
    case "description_en": return facts.descriptionEn;
    case "description_ar": return facts.descriptionAr;
  }
}

/** Deterministic quality of one field on one product. */
export function classifyField(facts: ProductFacts, field: EnrichmentField): Quality {
  const raw = fieldValue(facts, field);
  if (blank(raw)) return "MISSING";
  const v = String(raw).trim();
  if (PLACEHOLDERS.has(v.toLowerCase())) return "WEAK";

  if (fieldKind(field) === "keywords") {
    // A description sentence dumped into the keywords field is WEAK.
    const desc = field === "keywords_ar" ? facts.descriptionAr : facts.descriptionEn;
    if (!blank(desc) && v.trim() === String(desc).trim()) return "WEAK";
    if (looksLikeProse(v)) return "WEAK";
    if (parseKeywords(v).length < 2) return "WEAK"; // one token is too thin
    return "GOOD";
  }

  // description
  if (v.length < MIN_DESCRIPTION_LEN) return "WEAK";
  return "GOOD";
}

export interface FieldQuality { field: EnrichmentField; quality: Quality }

/** Classify every enrichable field for a product. */
export function classifyProduct(facts: ProductFacts): FieldQuality[] {
  return ENRICHMENT_FIELDS.map((field) => ({ field, quality: classifyField(facts, field) }));
}

/** Candidate reasons, restricted to fields that actually exist in the schema. */
export type CandidateReason =
  | "MISSING_KEYWORDS"
  | "WEAK_KEYWORDS"
  | "MISSING_DESCRIPTION"
  | "WEAK_DESCRIPTION";

export function reasonsFor(qualities: FieldQuality[]): CandidateReason[] {
  const out = new Set<CandidateReason>();
  for (const { field, quality } of qualities) {
    const kind = fieldKind(field);
    if (quality === "MISSING") out.add(kind === "keywords" ? "MISSING_KEYWORDS" : "MISSING_DESCRIPTION");
    else if (quality === "WEAK") out.add(kind === "keywords" ? "WEAK_KEYWORDS" : "WEAK_DESCRIPTION");
  }
  return [...out];
}

/** A product is a candidate when any enrichable field is MISSING or WEAK. */
export function isCandidate(qualities: FieldQuality[]): boolean {
  return qualities.some((q) => q.quality === "MISSING" || q.quality === "WEAK");
}

/** Fields eligible for generation (MISSING or WEAK — never GOOD). */
export function generatableFields(qualities: FieldQuality[]): EnrichmentField[] {
  return qualities.filter((q) => q.quality === "MISSING" || q.quality === "WEAK").map((q) => q.field);
}
