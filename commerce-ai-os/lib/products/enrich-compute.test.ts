// Tests for the AI catalog-completion core.
// Run: node --experimental-strip-types --test lib/products/enrich-compute.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { missingFields, buildEnrichPrompt, parseEnrichResult, type EnrichInput } from "./enrich-compute.ts";

const CATS = ["Face Care", "Hair Care", "Makeup"] as const;

const P = (o: Partial<EnrichInput>): EnrichInput => ({
  name_en: "Serum", name_ar: "سيروم", description_en: "A serum", description_ar: "سيروم", main_category: "Face Care", ...o,
});

test("missingFields flags empty Arabic name / description / category", () => {
  assert.deepEqual(missingFields(P({})), []);
  assert.deepEqual(missingFields(P({ name_ar: null })), ["name_ar"]);
  assert.deepEqual(missingFields(P({ name_ar: "  ", description_ar: "", main_category: null })),
    ["name_ar", "description_ar", "main_category"]);
});

test("buildEnrichPrompt lists the categories and mentions the photo only when present", () => {
  const withImg = buildEnrichPrompt(P({}), CATS, true);
  assert.match(withImg, /Face Care, Hair Care, Makeup/);
  assert.match(withImg, /مرفقة صورة/);
  const noImg = buildEnrichPrompt(P({}), CATS, false);
  assert.match(noImg, /لا توجد صورة/);
  assert.match(noImg, /image_matches = null/);
});

test("parseEnrichResult reads fields, coerces booleans, and gates the category", () => {
  const r = parseEnrichResult(
    'ok: {"name_ar":"كريم - Cream","description_ar":"وصف","main_category":"Face Care","ar_matches_en":false,"image_matches":true,"notes":"الصورة مختلفة"}',
    CATS,
  );
  assert.equal(r!.name_ar, "كريم - Cream");
  assert.equal(r!.main_category, "Face Care");
  assert.equal(r!.arMatchesEn, false);
  assert.equal(r!.imageMatches, true);
  assert.equal(r!.notes, "الصورة مختلفة");
});

test("parseEnrichResult blanks a category outside the list and null image verdict", () => {
  const r = parseEnrichResult('{"name_ar":"x","description_ar":"y","main_category":"Toys","image_matches":null}', CATS);
  assert.equal(r!.main_category, "");
  assert.equal(r!.imageMatches, null);
  assert.equal(parseEnrichResult("no json", CATS), null);
});
