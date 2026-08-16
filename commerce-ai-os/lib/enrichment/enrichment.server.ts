import "server-only";
// CH.6E — bulk AI product enrichment orchestrator (SERVER).
//
// Three operations:
//   • scanEnrichmentCandidates — READ-ONLY. Loads active products, classifies each
//     enrichable field (MISSING/WEAK/GOOD) deterministically, and returns the
//     candidates + summary. NO model call, NO writes.
//   • generateEnrichment       — WRITER-GATED (paid AI). Builds grounded prompts
//     from authoritative catalog facts, calls the provider behind a narrow
//     interface, validates output structurally, and returns SUGGESTIONS. Batched +
//     concurrency-limited; a single failure never aborts the batch. NO writes.
//   • applyEnrichment          — WRITER-GATED. Applies ONLY operator-approved
//     suggestions through the narrow Catalog metadata boundary, with stale-preview
//     protection and an audit row per applied change. Per-item UPDATED / UNCHANGED
//     / SKIPPED / FAILED.
//
// Never touches inventory, availability, barcode, images, or channel identity.

import { requireMalakWriter } from "@/lib/malak/authz";
import { isSignedIn } from "@/lib/auth/requireUser";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { insertAuditRow } from "@/lib/audit";
import { safeError } from "@/lib/security/safe-error";
import { CATEGORIES } from "@/lib/constants";
import {
  writeProductEnrichment,
  type EnrichmentWriteClient,
  type EnrichmentWriteColumn,
} from "@/lib/products/enrichment-write";
import { ENRICHMENT_FIELDS, isEnrichmentField, type EnrichmentField } from "./enrichment-fields.ts";
import {
  classifyProduct,
  reasonsFor,
  isCandidate,
  generatableFields,
  type ProductFacts,
  type FieldQuality,
  type CandidateReason,
  type Quality,
} from "./enrichment-classify.ts";
import { normalizeKeywords } from "./enrichment-keywords.ts";
import {
  buildEnrichmentSystemPrompt,
  buildEnrichmentUserPrompt,
  parseEnrichmentOutput,
} from "./enrichment-prompt.ts";
import {
  buildSuggestion,
  planEnrichmentApply,
  suggestionKey,
  type Suggestion,
} from "./enrichment-plan.ts";
import {
  createAnthropicEnrichmentProvider,
  type EnrichmentProvider,
} from "./enrichment-provider.server.ts";

const NOT_SIGNED_IN = "غير مسجّل الدخول.";
const MAX_GENERATE = 100; // hard batch cap (cost control §17)
const CONCURRENCY = 5;

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
const kwField = (f: EnrichmentField) => f === "keywords_en" || f === "keywords_ar";

// ── read PORT (select/eq/in/ilike/range only) ────────────────────────────────
interface QueryResult { data: unknown[] | null; error: unknown | null }
interface Filter extends PromiseLike<QueryResult> {
  eq(c: string, v: string): Filter;
  neq(c: string, v: string): Filter;
  in(c: string, v: string[]): Filter;
  ilike(c: string, v: string): Filter;
  range(a: number, b: number): Filter;
}
interface Select { select(cols: string): Filter }
interface ReadClient { from(table: string): Select }

async function loadBrands(sb: ReadClient): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const { data } = await sb.from("brands").select("id, name").range(0, 9999);
  for (const r of (Array.isArray(data) ? data : []) as Record<string, unknown>[]) {
    const id = str(r.id); const name = str(r.name);
    if (id && name) out.set(id, name);
  }
  return out;
}

async function loadVariantNames(sb: ReadClient, productIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (let i = 0; i < productIds.length; i += 300) {
    const chunk = productIds.slice(i, i + 300);
    const { data } = await sb.from("product_variants").select("parent_product_id, variant_name").in("parent_product_id", chunk);
    for (const r of (Array.isArray(data) ? data : []) as Record<string, unknown>[]) {
      const pid = str(r.parent_product_id); const name = str(r.variant_name);
      if (!pid || !name) continue;
      const list = out.get(pid) ?? [];
      list.push(name);
      out.set(pid, list);
    }
  }
  return out;
}

export interface ScanFilters {
  brand?: string;
  category?: string;
  sku?: string;
  field?: EnrichmentField;
  productIds?: string[];
  includeArchived?: boolean;
}

function toFacts(r: Record<string, unknown>, brands: Map<string, string>, variantNames: Map<string, string[]>): ProductFacts {
  const id = str(r.id) ?? "";
  return {
    productId: id, sku: str(r.sku),
    nameEn: str(r.name_en), nameAr: str(r.name_ar),
    descriptionEn: str(r.description_en), descriptionAr: str(r.description_ar),
    keywordsEn: str(r.keywords_en), keywordsAr: str(r.keywords_ar),
    brand: (str(r.brand_id) && brands.get(str(r.brand_id) as string)) || null,
    mainCategory: str(r.main_category), subCategory: str(r.sub_category),
    productType: str(r.product_type), color: str(r.color), size: str(r.size),
    variantNames: variantNames.get(id) ?? [],
    lifecycle: str(r.platform_status),
  };
}

async function loadFacts(sb: ReadClient, filters: ScanFilters): Promise<ProductFacts[]> {
  const cols = "id, sku, name_en, name_ar, description_en, description_ar, keywords_en, keywords_ar, brand_id, main_category, sub_category, product_type, color, size, platform_status";
  const rows: Record<string, unknown>[] = [];
  const brands = await loadBrands(sb);

  const applyFilters = (q: Filter): Filter => {
    let out = q;
    if (!filters.includeArchived) out = out.neq("platform_status", "Archived");
    if (filters.category) out = out.eq("main_category", filters.category);
    if (filters.sku) out = out.ilike("sku", `%${filters.sku}%`);
    return out;
  };

  if (filters.productIds && filters.productIds.length) {
    for (let i = 0; i < filters.productIds.length; i += 300) {
      const chunk = filters.productIds.slice(i, i + 300);
      const { data } = await sb.from("products").select(cols).in("id", chunk);
      for (const r of (Array.isArray(data) ? data : []) as Record<string, unknown>[]) rows.push(r);
    }
  } else {
    for (let from = 0; ; from += 1000) {
      const { data, error } = await applyFilters(sb.from("products").select(cols)).range(from, from + 999);
      if (error || !Array.isArray(data)) break;
      for (const r of data as Record<string, unknown>[]) rows.push(r);
      if (data.length < 1000) break;
    }
  }

  const brandId = filters.brand ? [...brands.entries()].find(([, n]) => n === filters.brand)?.[0] : undefined;
  const filtered = brandId ? rows.filter((r) => str(r.brand_id) === brandId) : rows;
  const ids = filtered.map((r) => str(r.id)).filter((v): v is string => !!v);
  const variantNames = await loadVariantNames(sb, ids);
  return filtered.map((r) => toFacts(r, brands, variantNames));
}

// ── SCAN ─────────────────────────────────────────────────────────────────────
export interface CandidateRow {
  productId: string;
  sku: string | null;
  name: string | null;
  brand: string | null;
  category: string | null;
  qualities: FieldQuality[];
  reasons: CandidateReason[];
  generatable: EnrichmentField[];
}

export interface ScanSummary {
  scanned: number;
  candidates: number;
  missingKeywords: number;
  missingDescriptions: number;
  weakContent: number;
  missingSeo: number; // deferred — no SEO field exists (always 0, reported for transparency)
}

export interface ScanResult { rows: CandidateRow[]; summary: ScanSummary }

export async function scanEnrichmentCandidates(filters: ScanFilters = {}): Promise<ScanResult | { error: string }> {
  if (!(await isSignedIn())) return { error: NOT_SIGNED_IN };
  const sb = createClient() as unknown as ReadClient;
  const facts = await loadFacts(sb, filters);

  const rows: CandidateRow[] = [];
  let missingKeywords = 0, missingDescriptions = 0, weakContent = 0;

  for (const f of facts) {
    let qualities = classifyProduct(f);
    if (filters.field) qualities = qualities.filter((q) => q.field === filters.field);
    if (!isCandidate(qualities)) continue;

    for (const q of qualities) {
      if (q.quality === "MISSING") { if (kwField(q.field)) missingKeywords++; else missingDescriptions++; }
      else if (q.quality === "WEAK") weakContent++;
    }
    rows.push({
      productId: f.productId, sku: f.sku, name: f.nameEn ?? f.nameAr,
      brand: f.brand, category: f.mainCategory,
      qualities, reasons: reasonsFor(qualities), generatable: generatableFields(qualities),
    });
  }

  return {
    rows,
    summary: { scanned: facts.length, candidates: rows.length, missingKeywords, missingDescriptions, weakContent, missingSeo: 0 },
  };
}

// ── GENERATE (writer-gated, paid AI, NO writes) ──────────────────────────────
export interface GenerateOptions {
  productIds?: string[];
  field?: EnrichmentField;
  provider?: EnrichmentProvider;
  /** hard cap on how many products to generate for this call. */
  limit?: number;
}
export interface GenerateStats { requested: number; generated: number; failed: number; insufficient: number; model: string }
export interface GenerateResult { suggestions: Suggestion[]; stats: GenerateStats }

/** Run tasks with a fixed concurrency limit, collecting results in order. */
async function pool<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export async function generateEnrichment(opts: GenerateOptions = {}): Promise<GenerateResult | { error: string }> {
  const writer = await requireMalakWriter();
  if (!writer.ok) return { error: writer.error };

  const sb = createClient() as unknown as ReadClient;
  const facts = await loadFacts(sb, { productIds: opts.productIds, field: opts.field, includeArchived: false });

  // Eligible products = have at least one generatable (MISSING/WEAK) field.
  const targets: { facts: ProductFacts; fields: EnrichmentField[]; qualities: FieldQuality[] }[] = [];
  for (const f of facts) {
    let qualities = classifyProduct(f);
    if (opts.field) qualities = qualities.filter((q) => q.field === opts.field);
    const fields = generatableFields(qualities);
    if (fields.length) targets.push({ facts: f, fields, qualities });
  }
  const cap = Math.min(opts.limit ?? MAX_GENERATE, MAX_GENERATE);
  const capped = targets.slice(0, cap);

  const provider = opts.provider ?? createAnthropicEnrichmentProvider();
  const system = buildEnrichmentSystemPrompt();
  let failed = 0, insufficient = 0;

  const perProduct = await pool(capped, CONCURRENCY, async ({ facts: f, fields, qualities }) => {
    const user = buildEnrichmentUserPrompt(f, fields, CATEGORIES);
    let output = null;
    try {
      let text = "";
      try { text = await provider.generate(system, user); }
      catch { text = await provider.generate(system, user); } // one retry for transient failure
      output = parseEnrichmentOutput(text);
    } catch { output = null; }

    return fields.map((field) => {
      const q = qualities.find((x) => x.field === field)?.quality ?? ("MISSING" as Quality);
      const currentValue =
        field === "keywords_en" ? f.keywordsEn : field === "keywords_ar" ? f.keywordsAr :
        field === "description_en" ? f.descriptionEn : f.descriptionAr;
      const s = buildSuggestion({ productId: f.productId, sku: f.sku, productName: f.nameEn ?? f.nameAr, field, currentValue, currentQuality: q, output });
      if (s.status === "FAILED") failed++;
      if (s.status === "INSUFFICIENT_DATA") insufficient++;
      return s;
    });
  });

  const suggestions = perProduct.flat();
  return {
    suggestions,
    stats: { requested: capped.length, generated: suggestions.filter((s) => s.status === "READY").length, failed, insufficient, model: provider.model },
  };
}

// ── APPLY (writer-gated, approved suggestions only) ──────────────────────────
export interface ApprovedSuggestion {
  productId: string;
  field: EnrichmentField;
  suggestedValue: string;
  /** the current value the operator saw at generation time (stale check). */
  currentValueAtGen: string | null;
}
export type ApplyStatus = "UPDATED" | "UNCHANGED" | "SKIPPED" | "FAILED";
export interface ApplyItem { productId: string; field: EnrichmentField; status: ApplyStatus; old: string | null; new: string | null; reason: string }
export interface ApplySummary { total: number; updated: number; unchanged: number; skipped: number; failed: number }
export interface ApplyResult { results: ApplyItem[]; summary: ApplySummary }

function normValue(field: EnrichmentField, value: string): string {
  return kwField(field) ? normalizeKeywords(value) : String(value ?? "").trim();
}

export async function applyEnrichment(approved: ApprovedSuggestion[]): Promise<ApplyResult | { error: string }> {
  const writer = await requireMalakWriter();
  if (!writer.ok) return { error: writer.error };

  const clean = (Array.isArray(approved) ? approved : [])
    .filter((a) => a && isEnrichmentField(a.field) && str(a.suggestedValue))
    .map((a) => ({ ...a, suggestedValue: normValue(a.field, a.suggestedValue) }))
    .filter((a) => a.suggestedValue !== "");
  if (clean.length === 0) return { results: [], summary: { total: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0 } };

  // Fresh values for the affected products (stale-preview protection §12).
  const sb = createClient() as unknown as ReadClient;
  const productIds = [...new Set(clean.map((a) => a.productId))];
  const freshByProduct = new Map<string, ProductFacts>();
  const facts = await loadFacts(sb, { productIds, includeArchived: true });
  for (const f of facts) freshByProduct.set(f.productId, f);

  const freshValue = (a: ApprovedSuggestion): string | null => {
    const f = freshByProduct.get(a.productId);
    if (!f) return null;
    return a.field === "keywords_en" ? f.keywordsEn : a.field === "keywords_ar" ? f.keywordsAr :
      a.field === "description_en" ? f.descriptionEn : f.descriptionAr;
  };

  // Build minimal READY suggestions for the pure planner.
  const suggestions: Suggestion[] = clean.map((a) => ({
    productId: a.productId, sku: null, productName: null, field: a.field,
    currentValue: a.currentValueAtGen, currentQuality: "MISSING", suggestedValue: a.suggestedValue,
    reason: "operator approved", status: "READY", autoEligible: true, notes: "",
  }));
  const freshValues = new Map<string, string | null>();
  for (const a of clean) freshValues.set(suggestionKey(a), freshValue(a));
  const selected = new Set(clean.map((a) => suggestionKey(a)));
  const plan = planEnrichmentApply({ suggestions, selected, freshValues });

  const admin = createAdminClient();
  const writeClient = admin as unknown as EnrichmentWriteClient;
  const at = new Date().toISOString();
  const results: ApplyItem[] = [];

  // Group apply items by product → one write per product (its approved fields).
  const applyByProduct = new Map<string, { field: EnrichmentField; value: string }[]>();
  for (const item of plan) {
    const old = clean.find((a) => a.productId === item.productId && a.field === item.field)?.currentValueAtGen ?? null;
    if (item.action === "stale") { results.push({ productId: item.productId, field: item.field, status: "SKIPPED", old, new: null, reason: item.reason }); continue; }
    if (item.action === "skip") { results.push({ productId: item.productId, field: item.field, status: "SKIPPED", old, new: null, reason: item.reason }); continue; }
    const list = applyByProduct.get(item.productId) ?? [];
    list.push({ field: item.field, value: item.suggestedValue });
    applyByProduct.set(item.productId, list);
  }

  for (const [productId, fields] of applyByProduct) {
    const patch: Partial<Record<EnrichmentWriteColumn, string>> = {};
    for (const { field, value } of fields) patch[field as EnrichmentWriteColumn] = value;
    try {
      const res = await writeProductEnrichment(writeClient, productId, patch);
      if (!res.ok) {
        for (const { field } of fields) results.push({ productId, field, status: "FAILED", old: null, new: null, reason: safeError("ch6e.write", res.error, "تعذّر حفظ الإثراء.") });
        continue;
      }
      const fresh = freshByProduct.get(productId);
      for (const { field, value } of fields) {
        const old = clean.find((a) => a.productId === productId && a.field === field)?.currentValueAtGen ?? null;
        await insertAuditRow(admin, {
          agent: "ai_enrichment",
          action: "catalog_enrich",
          action_type: "catalog_enrich",
          actor: writer.email,
          sku: fresh?.sku ?? null,
          product_id: productId,
          field,
          old_value: old ?? "(empty)",
          new_value: value,
          status: "done",
          details: { source: "ai", provider: "anthropic", field, reason: "bulk AI enrichment", at },
        }).catch(() => {});
        results.push({ productId, field, status: "UPDATED", old, new: value, reason: "applied AI suggestion" });
      }
    } catch (e) {
      for (const { field } of fields) results.push({ productId, field, status: "FAILED", old: null, new: null, reason: safeError("ch6e.apply", e, "تعذّر حفظ الإثراء.") });
    }
  }

  const summary = {
    total: results.length,
    updated: results.filter((r) => r.status === "UPDATED").length,
    unchanged: results.filter((r) => r.status === "UNCHANGED").length,
    skipped: results.filter((r) => r.status === "SKIPPED").length,
    failed: results.filter((r) => r.status === "FAILED").length,
  };
  return { results, summary };
}

export { ENRICHMENT_FIELDS };
