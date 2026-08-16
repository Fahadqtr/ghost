// CH.6E — Catalog enrichment field matrix (PURE).
//
// The SINGLE source of truth for which Catalog fields CH.6E may enrich. Derived
// from a live schema audit (§0): only fields that EXIST on the products table and
// are safe metadata are enrichable. Identity/commerce/inventory/availability/
// image/barcode/channel fields are intentionally absent, so no suggestion can
// ever reach them.
//
// PURE: no imports. node:test loads it directly.

/** Enrichment fields that map to a real, existing products column (SUPPORTED_NOW). */
export const ENRICHMENT_FIELDS = [
  "keywords_en",
  "keywords_ar",
  "description_en",
  "description_ar",
] as const;

export type EnrichmentField = (typeof ENRICHMENT_FIELDS)[number];

/** The products column each enrichment field writes (whitelist for the boundary). */
export const FIELD_COLUMN: Record<EnrichmentField, string> = {
  keywords_en: "keywords_en",
  keywords_ar: "keywords_ar",
  description_en: "description_en",
  description_ar: "description_ar",
};

export function isEnrichmentField(v: unknown): v is EnrichmentField {
  return typeof v === "string" && (ENRICHMENT_FIELDS as readonly string[]).includes(v);
}

/** Which of a field's language is Arabic (drives language-appropriate generation). */
export function isArabicField(f: EnrichmentField): boolean {
  return f === "keywords_ar" || f === "description_ar";
}
export function fieldKind(f: EnrichmentField): "keywords" | "description" {
  return f === "keywords_en" || f === "keywords_ar" ? "keywords" : "description";
}

/**
 * Fields desired by the CH.6E spec that DO NOT exist in the current schema —
 * recorded as follow-up debt. CH.6E writes NONE of these (no casual schema).
 */
export const DEFERRED_FIELDS = [
  { field: "meta_title", reason: "no SEO meta_title column on products" },
  { field: "meta_description", reason: "no SEO meta_description column on products" },
  { field: "image_alt_text", reason: "only image_url/image_filename exist; no alt-text column" },
  { field: "search_tags", reason: "no separate search_tags column (keywords_* serve this role)" },
  { field: "highlights", reason: "no highlights/bullets column on products" },
] as const;
