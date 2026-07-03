// Tests for the shared product-draft prompt/parser core.
// Run: node --experimental-strip-types --test lib/products/draft-compute.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { buildDraftPrompt, parseProductDraft, EMPTY_DRAFT } from "./draft-compute.ts";

const CATS = ["Skincare", "Rhode Products Section", "Hair Care"] as const;

// ---- buildDraftPrompt ----------------------------------------------------------

test("prompt embeds the allowed category list and demands JSON-only output", () => {
  const p = buildDraftPrompt(CATS);
  assert.ok(p.includes("Skincare, Rhode Products Section, Hair Care"));
  assert.ok(p.includes("JSON"));
  assert.ok(p.includes("🔸")); // house-style bullets are part of the contract
});

// ---- parseProductDraft ---------------------------------------------------------

test("parses a clean JSON reply and trims fields", () => {
  const d = parseProductDraft(
    '{"name_en":" Glow Serum ","name_ar":"سيروم","description_en":"x","description_ar":"y","keywords_en":"a,b","keywords_ar":"أ,ب","main_category":"Skincare"}',
    CATS,
  )!;
  assert.equal(d.name_en, "Glow Serum");
  assert.equal(d.main_category, "Skincare");
});

test("extracts the JSON block from surrounding prose", () => {
  const d = parseProductDraft('Sure! Here is the draft:\n```json\n{"name_en":"X","main_category":"Hair Care"}\n```', CATS)!;
  assert.equal(d.name_en, "X");
  assert.equal(d.main_category, "Hair Care");
});

test("missing fields become empty strings, never undefined", () => {
  const d = parseProductDraft('{"name_en":"X"}', CATS)!;
  assert.equal(d.name_ar, "");
  assert.equal(d.description_en, "");
  assert.equal(d.keywords_ar, "");
});

test("a category outside the allowed list is blanked, not passed through", () => {
  const d = parseProductDraft('{"name_en":"X","main_category":"Made Up"}', CATS)!;
  assert.equal(d.main_category, "");
});

test("no JSON at all → null (callers fall back to EMPTY_DRAFT)", () => {
  assert.equal(parseProductDraft("sorry, I cannot see the image", CATS), null);
  assert.equal(parseProductDraft("", CATS), null);
  assert.deepEqual(EMPTY_DRAFT.main_category, "");
});

test("malformed JSON → null instead of throwing", () => {
  assert.equal(parseProductDraft('{"name_en": unquoted}', CATS), null);
});
