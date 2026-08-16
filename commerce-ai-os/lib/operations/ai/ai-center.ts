// OPS.5 — AI Center composer (PURE).
//
// The AI Center is an ORCHESTRATION + review layer over the EXISTING CH.6E
// enrichment engine. It performs NO reads/writes and invents NO AI logic: it is a
// pure projection over the CH.6E scan (CandidateRow[] + summary), the CH.6E
// Suggestion shape (produced by the existing generate action, held client-side),
// and real applied-history events (malak_audit `catalog_enrich`). It reuses the
// CH.6E pure cores for field metadata, quality classification and keyword
// handling — never a second copy.
//
// Honesty invariants:
//   • generation is EPHEMERAL in CH.6E — Ready/NeedsReview/Failed/Stale counts are
//     LIVE-SESSION only (0 until an operator generates); they are never fabricated
//     from the scan. "Recently applied" is the only persisted history (audit).
//   • GOOD content is never generatable/auto-applied — that guarantee lives in
//     CH.6E (generatableFields / autoEligible) and is surfaced, not re-decided.
//   • deferred fields (meta title/description, alt text, search tags) stay
//     explicitly deferred — reused from the CH.6E DEFERRED_FIELDS registry.
//
// PURE: the only imports are the pure CH.6E siblings (relative, not `@/`). No
// server-only, no DB, no AI SDK — node:test loads it directly.

import {
  ENRICHMENT_FIELDS,
  DEFERRED_FIELDS,
  isEnrichmentField,
  isArabicField,
  fieldKind,
  type EnrichmentField,
} from "../../enrichment/enrichment-fields.ts";
import { type Quality, type FieldQuality, type CandidateReason } from "../../enrichment/enrichment-classify.ts";
import { parseKeywords, normalizeKeywordList } from "../../enrichment/enrichment-keywords.ts";
import { type Suggestion, type SuggestionStatus, suggestionKey } from "../../enrichment/enrichment-plan.ts";

export type { EnrichmentField, Quality, SuggestionStatus };

// Display constants — MIRROR the CH.6E cost controls (MAX_GENERATE / CONCURRENCY);
// CH.6E does not export them, so they are duplicated for DISPLAY only (never used
// to drive generation — the engine enforces the real caps).
export const AI_MAX_GENERATE = 100;
export const AI_CONCURRENCY = 5;

export const FIELD_LABEL: Record<EnrichmentField, string> = {
  keywords_en: "Keywords (EN)",
  keywords_ar: "الكلمات المفتاحية (AR)",
  description_en: "Description (EN)",
  description_ar: "الوصف (AR)",
};

// ── input shapes (structural SUBSETS of the CH.6E types) ─────────────────────────
export interface CcCandidate {
  productId: string;
  sku: string | null;
  name: string | null;
  brand: string | null;
  category: string | null;
  qualities: FieldQuality[];
  reasons: CandidateReason[];
  generatable: EnrichmentField[];
}

export interface CcScanSummary {
  scanned: number;
  candidates: number;
  missingKeywords: number;
  missingDescriptions: number;
  weakContent: number;
}

/** A real applied-enrichment event (from malak_audit `catalog_enrich`). */
export interface AiHistoryEvent {
  id: string;
  timestamp: string;
  sku: string | null;
  field: string | null;
  summary: string;
  status: string;
}

export interface AiCenterInput {
  summary: CcScanSummary;
  candidates: readonly CcCandidate[];
  /** persisted applied history (audit); the only real history that exists. */
  appliedRecently: readonly AiHistoryEvent[];
  /** live suggestions from a generate session (client-side); empty on server render. */
  suggestions?: readonly Suggestion[];
  /** provider config presence (a SAFE boolean; never the key) + last real success. */
  provider: { configured: boolean; lastSuccessAt: string | null; recentFailures?: number };
}

// ── existing workflow routes (OPS.5 introduces NO new mutation path) ─────────────
export const ROUTES = {
  ai: "/v2/operations/ai",
  aiEnrichment: "/v2/operations/ai-enrichment",
  catalog: "/v2/catalog",
  operations: "/v2/operations",
} as const;

// ── weak/missing per-kind counts (from the scan) ────────────────────────────────
function countFieldQuality(candidates: readonly CcCandidate[], kind: "keywords" | "description", quality: Quality): number {
  let n = 0;
  for (const c of candidates) {
    for (const q of c.qualities) {
      if (fieldKind(q.field) === kind && q.quality === quality) n++;
    }
  }
  return n;
}

// ── suggestion → queue classification (live session) ────────────────────────────
export type SuggestionBucket = "ready_review" | "needs_review" | "failed" | "unchanged";

/** Which review bucket a CH.6E suggestion belongs to. GOOD/equal → unchanged
 *  (never shown as actionable); MISSING READY → ready; WEAK READY / NEEDS_REVIEW /
 *  INSUFFICIENT_DATA → needs_review; FAILED → failed. */
export function classifySuggestion(s: Suggestion): SuggestionBucket {
  if (s.status === "FAILED") return "failed";
  if (s.status === "UNCHANGED") return "unchanged";
  if (s.status === "INSUFFICIENT_DATA" || s.status === "NEEDS_REVIEW") return "needs_review";
  // READY
  return s.autoEligible ? "ready_review" : "needs_review";
}

// ── dashboard (§2) ──────────────────────────────────────────────────────────────
export interface AiDashboard {
  productsNeedingAi: number;
  missingKeywords: number;
  weakKeywords: number;
  missingDescriptions: number;
  weakDescriptions: number;
  /** live-session counts (0 until an operator generates — never fabricated). */
  readySuggestions: number;
  needsReview: number;
  failedGenerations: number;
  staleSuggestions: number;
  recentlyApplied: number;
  /** fields the spec wants that the schema does not have — explicitly deferred. */
  deferred: { field: string; reason: string }[];
  scanned: number;
}

export function buildAiDashboard(input: AiCenterInput): AiDashboard {
  const sug = input.suggestions ?? [];
  const buckets = sug.map(classifySuggestion);
  return {
    productsNeedingAi: input.summary.candidates,
    missingKeywords: countFieldQuality(input.candidates, "keywords", "MISSING"),
    weakKeywords: countFieldQuality(input.candidates, "keywords", "WEAK"),
    missingDescriptions: countFieldQuality(input.candidates, "description", "MISSING"),
    weakDescriptions: countFieldQuality(input.candidates, "description", "WEAK"),
    readySuggestions: buckets.filter((b) => b === "ready_review").length,
    needsReview: buckets.filter((b) => b === "needs_review").length,
    failedGenerations: buckets.filter((b) => b === "failed").length,
    // "stale" is only knowable at apply time (CH.6E stale-preview protection); it
    // is never derived here — the workspace fills it from a real apply result.
    staleSuggestions: 0,
    recentlyApplied: input.appliedRecently.length,
    deferred: DEFERRED_FIELDS.map((d) => ({ field: d.field, reason: d.reason })),
    scanned: input.summary.scanned,
  };
}

// ── unified queues (§3) ─────────────────────────────────────────────────────────
export type AiQueueKey = "needs_generation" | "ready_review" | "needs_review" | "failed" | "stale" | "applied_recent";

export interface AiQueueRow {
  key: string;
  productId: string;
  sku: string | null;
  name: string | null;
  brand: string | null;
  field: EnrichmentField | null;
  currentQuality: Quality | null;
  suggestionStatus: SuggestionStatus | "APPLIED" | null;
  reason: string;
  action: "generate" | "approve" | "review" | "retry" | "view";
}

export const AI_QUEUE_LABEL: Record<AiQueueKey, string> = {
  needs_generation: "بحاجة توليد",
  ready_review: "جاهزة للمراجعة",
  needs_review: "بحاجة مراجعة",
  failed: "فشل التوليد",
  stale: "قديمة",
  applied_recent: "طُبّقت مؤخرًا",
};

const REASON_LABEL: Record<CandidateReason, string> = {
  MISSING_KEYWORDS: "كلمات مفتاحية ناقصة",
  MISSING_DESCRIPTION: "وصف ناقص",
  WEAK_KEYWORDS: "كلمات مفتاحية ضعيفة",
  WEAK_DESCRIPTION: "وصف ضعيف",
};

const reasonForField = (q: Quality, f: EnrichmentField): string => {
  const kind = fieldKind(f);
  if (q === "MISSING") return REASON_LABEL[kind === "keywords" ? "MISSING_KEYWORDS" : "MISSING_DESCRIPTION"];
  if (q === "WEAK") return REASON_LABEL[kind === "keywords" ? "WEAK_KEYWORDS" : "WEAK_DESCRIPTION"];
  return "";
};

export const DEFAULT_QUEUE_TOP = 50;

/** Build the "Needs Generation" queue from the read-only scan (one row per
 *  generatable field — GOOD fields are never included, per CH.6E). */
export function buildNeedsGenerationQueue(candidates: readonly CcCandidate[], top = DEFAULT_QUEUE_TOP): AiQueueRow[] {
  const rows: AiQueueRow[] = [];
  for (const c of candidates) {
    for (const q of c.qualities) {
      if (q.quality !== "MISSING" && q.quality !== "WEAK") continue;
      rows.push({
        key: `${c.productId}::${q.field}`,
        productId: c.productId,
        sku: c.sku,
        name: c.name,
        brand: c.brand,
        field: q.field,
        currentQuality: q.quality,
        suggestionStatus: null,
        reason: reasonForField(q.quality, q.field),
        action: "generate",
      });
      if (rows.length >= top) return rows;
    }
  }
  return rows;
}

/** Build the suggestion-derived queues (live session) from CH.6E suggestions. */
export function buildSuggestionQueues(suggestions: readonly Suggestion[]): Record<"ready_review" | "needs_review" | "failed", AiQueueRow[]> {
  const out = { ready_review: [] as AiQueueRow[], needs_review: [] as AiQueueRow[], failed: [] as AiQueueRow[] };
  for (const s of suggestions) {
    const bucket = classifySuggestion(s);
    if (bucket === "unchanged") continue;
    const row: AiQueueRow = {
      key: suggestionKey(s),
      productId: s.productId,
      sku: s.sku,
      name: s.productName,
      brand: null,
      field: s.field,
      currentQuality: s.currentQuality,
      suggestionStatus: s.status,
      reason: s.reason,
      action: bucket === "ready_review" ? "approve" : bucket === "failed" ? "retry" : "review",
    };
    out[bucket].push(row);
  }
  return out;
}

/** Applied-recently queue from real audit events. */
export function buildAppliedQueue(events: readonly AiHistoryEvent[], top = DEFAULT_QUEUE_TOP): AiQueueRow[] {
  return events.slice(0, top).map((e) => ({
    key: e.id,
    productId: "",
    sku: e.sku,
    name: null,
    brand: null,
    field: e.field && isEnrichmentField(e.field) ? e.field : null,
    currentQuality: null,
    suggestionStatus: "APPLIED",
    reason: e.summary,
    action: "view",
  }));
}

// ── side-by-side keyword diff (§7) ──────────────────────────────────────────────
export interface KeywordDiff {
  current: string[];
  suggested: string[];
  added: string[]; //   in suggested, not in current
  removed: string[]; // in current, not in suggested
  kept: string[]; //    in both
}

/** Language-aware, de-duplicated keyword comparison (reuses the CH.6E keyword
 *  normalizer). Case-insensitive membership; original casing preserved. */
export function keywordDiff(current: string | null, suggested: string | null): KeywordDiff {
  const cur = normalizeKeywordList(parseKeywords(current ?? ""));
  const sug = normalizeKeywordList(parseKeywords(suggested ?? ""));
  const curSet = new Set(cur.map((t) => t.toLowerCase()));
  const sugSet = new Set(sug.map((t) => t.toLowerCase()));
  return {
    current: cur,
    suggested: sug,
    added: sug.filter((t) => !curSet.has(t.toLowerCase())),
    removed: cur.filter((t) => !sugSet.has(t.toLowerCase())),
    kept: sug.filter((t) => curSet.has(t.toLowerCase())),
  };
}

// ── controlled apply mapping (§14) ──────────────────────────────────────────────
export interface ApprovedSuggestionLite {
  productId: string;
  field: EnrichmentField;
  suggestedValue: string;
  currentValueAtGen: string | null;
}

/** Map operator-selected READY suggestions to the CH.6E ApprovedSuggestion shape.
 *  ONLY READY suggestions with a non-empty value are eligible (GOOD/UNCHANGED/
 *  FAILED can never be selected for apply) — the engine re-checks staleness. */
export function toApproved(suggestions: readonly Suggestion[], selectedKeys: ReadonlySet<string>): ApprovedSuggestionLite[] {
  const out: ApprovedSuggestionLite[] = [];
  for (const s of suggestions) {
    if (!selectedKeys.has(suggestionKey(s))) continue;
    if (s.status !== "READY" || s.suggestedValue.trim() === "") continue;
    out.push({ productId: s.productId, field: s.field, suggestedValue: s.suggestedValue, currentValueAtGen: s.currentValue });
  }
  return out;
}

// ── filters (§9) ────────────────────────────────────────────────────────────────
export type LanguageFilter = "ar" | "en" | "all";
export const LANGUAGE_FILTERS: readonly LanguageFilter[] = ["ar", "en", "all"];
export const QUALITY_FILTERS: readonly Quality[] = ["MISSING", "WEAK", "GOOD", "NEEDS_REVIEW"];

export interface AiFilters {
  brand: string | null;
  category: string | null;
  field: EnrichmentField | null;
  language: LanguageFilter;
  quality: Quality | null;
  status: SuggestionStatus | null;
  sku: string | null;
}

export const EMPTY_AI_FILTERS: AiFilters = { brand: null, category: null, field: null, language: "all", quality: null, status: null, sku: null };

const one = (v: unknown): string | null => {
  const x = Array.isArray(v) ? v[0] : v;
  return typeof x === "string" && x.trim() !== "" ? x.trim() : null;
};

const SUGGESTION_STATUSES: readonly SuggestionStatus[] = ["READY", "UNCHANGED", "NEEDS_REVIEW", "INSUFFICIENT_DATA", "FAILED"];

/** Parse + VALIDATE deep-link / filter params against known enums (§10). Unknown
 *  values fall back to the neutral default — never forwarded raw. */
export function parseAiFilters(params: Record<string, unknown>): AiFilters {
  const field = one(params.field);
  const lang = one(params.language);
  const quality = one(params.quality);
  const statusRaw = one(params.status);
  // deep-links from OPS.1/OPS.3 may use lowercase issue-ish status like
  // "needs_review"; map it to the canonical SuggestionStatus when it matches.
  const status = statusRaw ? statusRaw.toUpperCase() : null;
  return {
    brand: one(params.brand),
    category: one(params.category),
    field: field && isEnrichmentField(field) ? (field as EnrichmentField) : null,
    language: lang === "ar" || lang === "en" ? lang : "all",
    quality: quality && (QUALITY_FILTERS as readonly string[]).includes(quality.toUpperCase()) ? (quality.toUpperCase() as Quality) : null,
    status: status && (SUGGESTION_STATUSES as readonly string[]).includes(status) ? (status as SuggestionStatus) : null,
    sku: one(params.sku),
  };
}

/** The scan-side filters (brand/category/field/sku) that CH.6E's scanner accepts. */
export function scanFiltersFrom(f: AiFilters): { brand?: string; category?: string; field?: EnrichmentField; sku?: string } {
  return {
    ...(f.brand ? { brand: f.brand } : {}),
    ...(f.category ? { category: f.category } : {}),
    ...(f.field ? { field: f.field } : {}),
    ...(f.sku ? { sku: f.sku } : {}),
  };
}

function fieldMatchesLanguage(field: EnrichmentField, lang: LanguageFilter): boolean {
  if (lang === "all") return true;
  return lang === "ar" ? isArabicField(field) : !isArabicField(field);
}

/** Pure post-filter of candidate rows by language / quality (brand/category/field/
 *  sku are applied by the scanner). Keeps Arabic and English independent (§8). */
export function filterCandidates(candidates: readonly CcCandidate[], f: AiFilters): CcCandidate[] {
  return candidates
    .map((c) => {
      // narrow the per-field qualities to the language + quality filter
      const qualities = c.qualities.filter(
        (q) => fieldMatchesLanguage(q.field, f.language) && (!f.quality || q.quality === f.quality),
      );
      return { ...c, qualities, generatable: c.generatable.filter((g) => fieldMatchesLanguage(g, f.language)) };
    })
    .filter((c) => c.qualities.some((q) => q.quality === "MISSING" || q.quality === "WEAK") || (f.quality === "GOOD" && c.qualities.length > 0));
}

/** Reflect the active filters back into a shareable query string (§10). */
export function filtersToQuery(f: AiFilters): string {
  const p = new URLSearchParams();
  if (f.brand) p.set("brand", f.brand);
  if (f.category) p.set("category", f.category);
  if (f.field) p.set("field", f.field);
  if (f.language !== "all") p.set("language", f.language);
  if (f.quality) p.set("quality", f.quality);
  if (f.status) p.set("status", f.status);
  if (f.sku) p.set("sku", f.sku);
  const s = p.toString();
  return s ? `?${s}` : "";
}

// ── provider diagnostics (§16) ──────────────────────────────────────────────────
export type ProviderState = "AVAILABLE" | "DEGRADED" | "UNAVAILABLE";
export interface ProviderDiagnostics {
  state: ProviderState;
  reason: string;
  lastSuccessAt: string | null;
  recentFailures: number;
}

/** Map SAFE provider signals to an operational state. Never sees a key/secret —
 *  `configured` is a boolean the server derived from env presence. DEGRADED comes
 *  only from live generate failures the caller passes. */
export function mapProviderDiagnostics(input: { configured: boolean; lastSuccessAt: string | null; recentFailures?: number }): ProviderDiagnostics {
  const recentFailures = input.recentFailures ?? 0;
  if (!input.configured) {
    return { state: "UNAVAILABLE", reason: "مزوّد الذكاء غير مُهيّأ (لا يوجد مفتاح).", lastSuccessAt: input.lastSuccessAt, recentFailures };
  }
  if (recentFailures > 0) {
    return { state: "DEGRADED", reason: `فشل ${recentFailures} توليد مؤخرًا.`, lastSuccessAt: input.lastSuccessAt, recentFailures };
  }
  return { state: "AVAILABLE", reason: "المزوّد جاهز.", lastSuccessAt: input.lastSuccessAt, recentFailures };
}

// ── request estimate (§5/§17) ───────────────────────────────────────────────────
/** CH.6E issues ONE model call per product (all generatable fields at once),
 *  capped at AI_MAX_GENERATE. This mirrors that for display before generation. */
export function estimateRequests(eligibleProducts: number): number {
  return Math.min(Math.max(0, eligibleProducts), AI_MAX_GENERATE);
}

// ── top-level compose ───────────────────────────────────────────────────────────
export interface AiCenterModel {
  dashboard: AiDashboard;
  needsGeneration: AiQueueRow[];
  appliedRecent: AiQueueRow[];
  diagnostics: ProviderDiagnostics;
  estimatedRequests: number;
  fields: { key: EnrichmentField; label: string }[];
}

export function buildAiCenter(input: AiCenterInput): AiCenterModel {
  const needsGeneration = buildNeedsGenerationQueue(input.candidates);
  return {
    dashboard: buildAiDashboard(input),
    needsGeneration,
    appliedRecent: buildAppliedQueue(input.appliedRecently),
    diagnostics: mapProviderDiagnostics({ configured: input.provider.configured, lastSuccessAt: input.provider.lastSuccessAt, recentFailures: input.provider.recentFailures }),
    estimatedRequests: estimateRequests(new Set(input.candidates.map((c) => c.productId)).size),
    fields: ENRICHMENT_FIELDS.map((k) => ({ key: k, label: FIELD_LABEL[k] })),
  };
}
