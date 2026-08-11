// Unified AI proposal layer (UX.4D-1). PURE — no I/O, no framework, no model
// call, no prompt. It maps the outputs of the EXISTING AI engines (VisionExtract,
// ProductDraft, EnrichResult) into ONE safe proposal shape, then applies that
// proposal to the current form field values in a "fill-missing" (default) or
// "overwrite-selected" way. It NEVER writes a database, never calls a model, and
// never re-defines a prompt — the prompts/parsers stay exactly where they are.
//
// Identity and commerce fields are DELIBERATELY absent from the contract, so no
// AI value can ever reach them: sku, barcode, price, discount_price, cost, stock,
// approval, platform_status, and the image fields are not representable here.

// Type-only imports (erased at runtime → this module stays node-loadable and
// pulls in NONE of the prompt/parser/model code).
import type { VisionExtract } from "./ai-extract.ts";
import type { ProductDraft } from "./draft-compute.ts";
import type { EnrichResult } from "./enrich-compute.ts";

export type GenerationConfidence = "high" | "medium" | "low";

/** How the proposal was produced (metadata only — never applied to a field). */
export type ProductGenerationSource = "image" | "text" | "image+text" | "existing" | "existing+image";

/**
 * The single, safe AI proposal shape. Every key is an OPTIONAL, content-only
 * product field. `confidence`/`source` are metadata, not applyable fields.
 * Identity/commerce/image fields are intentionally not part of the type.
 */
export interface ProductGenerationProposal {
  nameAr?: string;
  nameEn?: string;
  descriptionAr?: string;
  descriptionEn?: string;
  brand?: string; // a raw brand STRING only — never resolved to brand_id here
  mainCategory?: string;
  subCategory?: string;
  productType?: string;
  color?: string;
  size?: string;
  keywordsAr?: string;
  keywordsEn?: string;
  confidence?: GenerationConfidence;
  source?: ProductGenerationSource;
}

/** The applyable content fields (excludes confidence/source metadata). */
export const PRODUCT_GENERATION_FIELDS = [
  "nameAr",
  "nameEn",
  "descriptionAr",
  "descriptionEn",
  "brand",
  "mainCategory",
  "subCategory",
  "productType",
  "color",
  "size",
  "keywordsAr",
  "keywordsEn",
] as const;

export type ProductGenerationField = (typeof PRODUCT_GENERATION_FIELDS)[number];

function isBlank(v: unknown): boolean {
  return typeof v !== "string" || v.trim() === "";
}

/** Trimmed proposal value for a field, or "" when absent/blank. */
function offeredValue(proposal: ProductGenerationProposal, field: ProductGenerationField): string {
  const v = proposal[field];
  return typeof v === "string" ? v.trim() : "";
}

// ── mapping ──────────────────────────────────────────────────────────────────

/** Add a field to the proposal only when the source value is a real (non-blank)
 *  string — never invent a value, never carry an empty. */
function put(
  target: ProductGenerationProposal,
  field: ProductGenerationField,
  raw: unknown,
): void {
  if (typeof raw === "string" && raw.trim() !== "") target[field] = raw.trim();
}

/**
 * Map an existing AI engine output into the unified proposal. MAPPING ONLY:
 * it renames fields (notably `shade` → `color`), carries `confidence` only when
 * the source actually has it, tags the `source`, and drops everything that is
 * not a content field (identity, image, and Enrich's verification signals
 * arMatchesEn/imageMatches/notes are never mapped to product fields).
 */
export function toProductGenerationProposal(
  raw: VisionExtract | ProductDraft | EnrichResult,
  source: ProductGenerationSource,
): ProductGenerationProposal {
  const out: ProductGenerationProposal = { source };

  if ("shade" in raw) {
    // VisionExtract — the richest source (image), with confidence.
    const v = raw as VisionExtract;
    put(out, "nameAr", v.name_ar);
    put(out, "nameEn", v.name_en);
    put(out, "descriptionAr", v.description_ar);
    put(out, "descriptionEn", v.description_en);
    put(out, "brand", v.brand);
    put(out, "mainCategory", v.main_category);
    put(out, "productType", v.product_type);
    put(out, "color", v.shade); // shade → color
    put(out, "size", v.size);
    put(out, "keywordsAr", v.keywords_ar);
    put(out, "keywordsEn", v.keywords_en);
    if (v.confidence === "high" || v.confidence === "medium" || v.confidence === "low") {
      out.confidence = v.confidence;
    }
    return out;
  }

  if ("arMatchesEn" in raw) {
    // EnrichResult — text/existing-data fill (Arabic name/description + category).
    // Verification signals are NOT product fields and are never mapped.
    const e = raw as EnrichResult;
    put(out, "nameAr", e.name_ar);
    put(out, "descriptionAr", e.description_ar);
    put(out, "mainCategory", e.main_category);
    return out; // EnrichResult has no confidence field → none carried
  }

  // ProductDraft — the older image draft (no brand/type/color/size/confidence).
  const d = raw as ProductDraft;
  put(out, "nameAr", d.name_ar);
  put(out, "nameEn", d.name_en);
  put(out, "descriptionAr", d.description_ar);
  put(out, "descriptionEn", d.description_en);
  put(out, "mainCategory", d.main_category);
  put(out, "keywordsAr", d.keywords_ar);
  put(out, "keywordsEn", d.keywords_en);
  return out;
}

// ── apply ────────────────────────────────────────────────────────────────────

export interface ApplyProposalOptions {
  /** Default "fill-missing": only empty/whitespace fields are filled. */
  mode?: "fill-missing" | "overwrite-selected";
  /** In "overwrite-selected", the explicit fields the user chose to overwrite. */
  fields?: readonly ProductGenerationField[];
}

export interface ApplyProposalResult {
  /** The full field record after applying (every content field present). */
  next: Record<ProductGenerationField, string>;
  /** Fields whose value changed. */
  applied: ProductGenerationField[];
  /** Offered fields that were not applied (already filled, not selected, or held for review). */
  skipped: ProductGenerationField[];
  /** True when the proposal is low-confidence — the caller should ask the user to review. */
  reviewRequired: boolean;
}

/**
 * Apply a proposal to the current field values.
 *
 * - "fill-missing" (default): fill ONLY fields that are currently blank; existing
 *   values are never overwritten, and an empty proposal field never clears one.
 *   Low confidence blocks this automatic fill (nothing applied, reviewRequired).
 * - "overwrite-selected": apply ONLY the explicitly-chosen `fields` (a deliberate
 *   user action) — never a blanket overwrite. reviewRequired still flags low
 *   confidence so the UI can warn, but the explicit choice is honored.
 *
 * Pure and deterministic: same inputs → same result.
 */
export function applyProductGenerationProposal(
  current: Partial<Record<ProductGenerationField, string>>,
  proposal: ProductGenerationProposal,
  options?: ApplyProposalOptions,
): ApplyProposalResult {
  const mode = options?.mode ?? "fill-missing";
  const reviewRequired = proposal.confidence === "low";
  const chosen = new Set(options?.fields ?? []);

  // Fields the proposal actually offers (non-blank), in canonical order.
  const offered = PRODUCT_GENERATION_FIELDS.filter((f) => offeredValue(proposal, f) !== "");

  const applied: ProductGenerationField[] = [];
  const skipped: ProductGenerationField[] = [];

  // Start from a normalized full record of the current values.
  const next = {} as Record<ProductGenerationField, string>;
  for (const f of PRODUCT_GENERATION_FIELDS) {
    const cur = current[f];
    next[f] = typeof cur === "string" ? cur : "";
  }

  for (const f of offered) {
    let apply: boolean;
    if (mode === "overwrite-selected") {
      apply = chosen.has(f); // explicit selection only
    } else {
      // fill-missing: only blanks, and never when the proposal is low-confidence.
      apply = !reviewRequired && isBlank(next[f]);
    }
    if (apply) {
      next[f] = offeredValue(proposal, f);
      applied.push(f);
    } else {
      skipped.push(f);
    }
  }

  return { next, applied, skipped, reviewRequired };
}
