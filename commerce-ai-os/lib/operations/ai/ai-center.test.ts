// OPS.5 — AI Center composer unit tests (§19). Pure — node:test loads it directly.
// node --conditions=react-server --experimental-strip-types --test lib/operations/ai/ai-center.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAiCenter,
  buildAiDashboard,
  buildNeedsGenerationQueue,
  buildSuggestionQueues,
  classifySuggestion,
  keywordDiff,
  toApproved,
  parseAiFilters,
  filterCandidates,
  filtersToQuery,
  scanFiltersFrom,
  mapProviderDiagnostics,
  estimateRequests,
  AI_MAX_GENERATE,
  type AiCenterInput,
  type CcCandidate,
} from "./ai-center.ts";
import type { Suggestion } from "../../enrichment/enrichment-plan.ts";

// ── fixtures ───────────────────────────────────────────────────────────────────
const cand = (over: Partial<CcCandidate> = {}): CcCandidate => ({
  productId: "p1",
  sku: "SKU-1",
  name: "Alpha",
  brand: "B1",
  category: "Makeup",
  qualities: [
    { field: "keywords_en", quality: "MISSING" },
    { field: "keywords_ar", quality: "GOOD" },
    { field: "description_en", quality: "WEAK" },
    { field: "description_ar", quality: "GOOD" },
  ],
  reasons: ["MISSING_KEYWORDS", "WEAK_DESCRIPTION"],
  generatable: ["keywords_en", "description_en"],
  ...over,
});

const sug = (over: Partial<Suggestion> = {}): Suggestion => ({
  productId: "p1",
  sku: "SKU-1",
  productName: "Alpha",
  field: "keywords_en",
  currentValue: null,
  currentQuality: "MISSING",
  suggestedValue: "red, lipstick, matte",
  reason: "fills a missing field",
  status: "READY",
  autoEligible: true,
  notes: "",
  ...over,
});

const input = (over: Partial<AiCenterInput> = {}): AiCenterInput => ({
  summary: { scanned: 100, candidates: 1, missingKeywords: 1, missingDescriptions: 0, weakContent: 1 },
  candidates: [cand()],
  appliedRecently: [{ id: "a1", timestamp: "2026-08-16T10:00:00Z", sku: "S9", field: "keywords_en", summary: "applied", status: "done" }],
  provider: { configured: true, lastSuccessAt: "2026-08-16T10:00:00Z" },
  ...over,
});

// ── dashboard aggregation (§2) ──────────────────────────────────────────────────
test("dashboard aggregates scan-based counts + real applied history; deferred fields listed", () => {
  const d = buildAiDashboard(input());
  assert.equal(d.missingKeywords, 1);
  assert.equal(d.weakDescriptions, 1);
  assert.equal(d.missingDescriptions, 0);
  assert.equal(d.recentlyApplied, 1);
  assert.equal(d.readySuggestions, 0); // no live suggestions on server render
  assert.ok(d.deferred.some((x) => x.field === "meta_title"));
  assert.ok(d.deferred.some((x) => x.field === "image_alt_text"));
});

test("live suggestion counts populate the dashboard only from a generate session", () => {
  const d = buildAiDashboard(input({ suggestions: [sug(), sug({ field: "description_en", currentQuality: "WEAK", autoEligible: false }), sug({ field: "keywords_ar", status: "FAILED", suggestedValue: "" })] }));
  assert.equal(d.readySuggestions, 1); // MISSING READY
  assert.equal(d.needsReview, 1); //     WEAK READY needs explicit review
  assert.equal(d.failedGenerations, 1);
  assert.equal(d.staleSuggestions, 0); // stale only known at apply
});

// ── queue classification (§3) ───────────────────────────────────────────────────
test("needs-generation queue lists only MISSING/WEAK fields (GOOD never queued)", () => {
  const rows = buildNeedsGenerationQueue([cand()]);
  assert.equal(rows.length, 2); // keywords_en(MISSING) + description_en(WEAK); the two GOOD are excluded
  assert.ok(rows.every((r) => r.currentQuality === "MISSING" || r.currentQuality === "WEAK"));
  assert.ok(rows.every((r) => r.action === "generate"));
});

test("suggestion queues bucket ready/needs-review/failed correctly", () => {
  const q = buildSuggestionQueues([
    sug(), // MISSING READY → ready
    sug({ field: "description_en", currentQuality: "WEAK", autoEligible: false }), // WEAK READY → needs review
    sug({ field: "keywords_ar", status: "INSUFFICIENT_DATA", suggestedValue: "" }), // → needs review
    sug({ field: "description_ar", status: "FAILED", suggestedValue: "" }), // → failed
    sug({ field: "keywords_ar", status: "UNCHANGED" }), // GOOD/equal → not queued
  ]);
  assert.equal(q.ready_review.length, 1);
  assert.equal(q.needs_review.length, 2);
  assert.equal(q.failed.length, 1);
});

test("classifySuggestion: GOOD/UNCHANGED never actionable", () => {
  assert.equal(classifySuggestion(sug({ status: "UNCHANGED" })), "unchanged");
  assert.equal(classifySuggestion(sug({ status: "READY", autoEligible: true })), "ready_review");
  assert.equal(classifySuggestion(sug({ status: "READY", autoEligible: false })), "needs_review");
  assert.equal(classifySuggestion(sug({ status: "FAILED" })), "failed");
});

// ── filters + Arabic/English isolation (§8/§9) ──────────────────────────────────
test("language filter keeps Arabic and English independent", () => {
  const c = cand({
    qualities: [
      { field: "keywords_en", quality: "MISSING" },
      { field: "keywords_ar", quality: "WEAK" },
    ],
    generatable: ["keywords_en", "keywords_ar"],
  });
  const en = filterCandidates([c], parseAiFilters({ language: "en" }));
  assert.deepEqual(en[0].qualities.map((q) => q.field), ["keywords_en"]);
  const ar = filterCandidates([c], parseAiFilters({ language: "ar" }));
  assert.deepEqual(ar[0].qualities.map((q) => q.field), ["keywords_ar"]);
});

test("quality filter narrows per-field quality", () => {
  const missingOnly = filterCandidates([cand()], parseAiFilters({ quality: "missing" }));
  assert.ok(missingOnly[0].qualities.every((q) => q.quality === "MISSING"));
});

test("scanFiltersFrom forwards only the scanner-supported keys", () => {
  const sf = scanFiltersFrom(parseAiFilters({ brand: "B1", category: "Makeup", field: "keywords_en", sku: "X", language: "ar", quality: "MISSING", status: "READY" }));
  assert.deepEqual(sf, { brand: "B1", category: "Makeup", field: "keywords_en", sku: "X" });
});

// ── deep links (§10) ────────────────────────────────────────────────────────────
test("deep-link params validate against enums; junk falls back to neutral", () => {
  const f = parseAiFilters({ field: "keywords_ar", language: "ar", quality: "weak", status: "needs_review", brand: "B1" });
  assert.equal(f.field, "keywords_ar");
  assert.equal(f.language, "ar");
  assert.equal(f.quality, "WEAK");
  assert.equal(f.status, "NEEDS_REVIEW");
  const bad = parseAiFilters({ field: "evil", language: "zz", quality: "HAX", status: "DROP" });
  assert.equal(bad.field, null);
  assert.equal(bad.language, "all");
  assert.equal(bad.quality, null);
  assert.equal(bad.status, null);
});

test("filters round-trip back into a shareable query string", () => {
  assert.equal(filtersToQuery(parseAiFilters({ brand: "B1", field: "keywords_en", language: "en" })), "?brand=B1&field=keywords_en&language=en");
  assert.equal(filtersToQuery(parseAiFilters({})), "");
});

// ── review selection / approve / apply mapping (§6/§14) ─────────────────────────
test("toApproved selects ONLY READY suggestions the operator ticked", () => {
  const suggestions = [sug(), sug({ field: "description_en", status: "FAILED", suggestedValue: "" }), sug({ field: "keywords_ar", status: "UNCHANGED" })];
  // nothing selected → nothing approved
  assert.equal(toApproved(suggestions, new Set()).length, 0);
  // select all keys → only the READY one is approved (FAILED + UNCHANGED excluded)
  const all = new Set(["p1::keywords_en", "p1::description_en", "p1::keywords_ar"]);
  const approved = toApproved(suggestions, all);
  assert.equal(approved.length, 1);
  assert.equal(approved[0].field, "keywords_en");
  assert.equal(approved[0].currentValueAtGen, null); // carries the stale-check value
});

test("GOOD content can never be selected for apply (not READY)", () => {
  const good = sug({ status: "UNCHANGED", currentQuality: "GOOD" });
  assert.equal(toApproved([good], new Set(["p1::keywords_en"])).length, 0);
});

// ── side-by-side keyword diff (§7) ──────────────────────────────────────────────
test("keywordDiff computes additions/removals, deduped + case-insensitive", () => {
  const kd = keywordDiff("Red, lipstick", "red, lipstick, matte, matte");
  assert.deepEqual(kd.added, ["matte"]); // deduped
  assert.deepEqual(kd.removed, []);
  assert.deepEqual(kd.kept.map((t) => t.toLowerCase()), ["red", "lipstick"]);
});

// ── provider diagnostics (§16) ──────────────────────────────────────────────────
test("provider diagnostics map safe signals to AVAILABLE/DEGRADED/UNAVAILABLE", () => {
  assert.equal(mapProviderDiagnostics({ configured: false, lastSuccessAt: null }).state, "UNAVAILABLE");
  assert.equal(mapProviderDiagnostics({ configured: true, lastSuccessAt: null }).state, "AVAILABLE");
  assert.equal(mapProviderDiagnostics({ configured: true, lastSuccessAt: null, recentFailures: 3 }).state, "DEGRADED");
});

// ── request estimate (§5/§17) ───────────────────────────────────────────────────
test("estimateRequests is one-call-per-product, capped at the CH.6E batch cap", () => {
  assert.equal(estimateRequests(30), 30);
  assert.equal(estimateRequests(1000), AI_MAX_GENERATE);
  assert.equal(estimateRequests(0), 0);
});

// ── whole model (read-only shape) ───────────────────────────────────────────────
test("buildAiCenter composes a complete read-only model", () => {
  const m = buildAiCenter(input());
  assert.equal(m.dashboard.productsNeedingAi, 1);
  assert.equal(m.needsGeneration.length, 2);
  assert.equal(m.appliedRecent.length, 1);
  assert.equal(m.diagnostics.state, "AVAILABLE");
  assert.equal(m.estimatedRequests, 1);
  assert.equal(m.fields.length, 4);
});

test("provider UNAVAILABLE flows through the whole model", () => {
  const m = buildAiCenter(input({ provider: { configured: false, lastSuccessAt: null } }));
  assert.equal(m.diagnostics.state, "UNAVAILABLE");
});
