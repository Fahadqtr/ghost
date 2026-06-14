// Tests for 4B (Arabic word-boundary) + size-requirement relaxation.
// Run: node --experimental-strip-types --test lib/compliance/rulesFix.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { runChecks, DEFAULT_RULES } from "./checker.ts";
import type { Draft } from "./types.ts";

const R = DEFAULT_RULES;
const base = (over: Partial<Draft>): Draft => ({
  sku: "mk1234", title_en: "X", title_ar: "س", name_en: "X", name_ar: "س",
  main_category: "Body Care", desc_en: "ok", desc_ar: "وصف عادي",
  keywords_en: "a, b, c, d, e", keywords_ar: "ا, ب, ت, ث, ج",
  size: "50g", price: 89, discount_price: null, image_url: "https://cdn/x.jpg", ...over,
});
const med = (d: Draft) => runChecks(d, R).checks.find((c) => c.name === "medical_claims")!.severity;
const req = (d: Draft) => runChecks(d, R).checks.find((c) => c.name === "required_fields")!.severity;

// STEP 1 — 4B Arabic word boundary -------------------------------------------
test("طبيعي (natural) does NOT trigger medical_claims", () => {
  assert.equal(med(base({ desc_ar: "كريم طبيعي ١٠٠٪ للبشرة" })), "PASS");
});
test("طبيعية (natural, fem.) does NOT trigger medical_claims", () => {
  assert.equal(med(base({ desc_ar: "مكونات طبيعية ومنعشة" })), "PASS");
});
test("standalone طبي DOES trigger medical_claims", () => {
  assert.equal(med(base({ desc_ar: "هذا منتج طبي معتمد" })), "BLOCK");
});
test("real claim يعالج still triggers medical_claims", () => {
  assert.equal(med(base({ desc_ar: "كريم يعالج حب الشباب نهائياً" })), "BLOCK");
});
test("prefixed العلاج still triggers medical_claims", () => {
  assert.equal(med(base({ desc_ar: "العلاج الفعّال للبشرة" })), "BLOCK");
});
test("English whole-word boundary still works (cures vs accures)", () => {
  assert.equal(med(base({ desc_en: "this cures acne" })), "BLOCK");
  assert.equal(med(base({ desc_en: "accuracy and precision" })), "PASS");
});

// STEP 2 — size no longer required -------------------------------------------
test("missing size alone does NOT cause required_fields WARN", () => {
  assert.equal(req(base({ size: null })), "PASS");
  assert.equal(runChecks(base({ size: null }), R).overall, "PASS");
});
test("keywords are still required (short keywords → WARN even with size null)", () => {
  assert.equal(req(base({ size: null, keywords_en: "only, three, kw" })), "WARN");
});
test("missing name/desc still required", () => {
  assert.equal(req(base({ size: null, desc_ar: "" })), "WARN");
});

// Nail-jargon exception (medical_jargon_exceptions) ---------------------------
test("'cure gel polish' (nail jargon) does NOT trigger medical", () => {
  assert.equal(med(base({ desc_en: "Designed to evenly cure gel polish and gel nails." })), "PASS");
});
test("'cures quickly under uv and led lamps' does NOT trigger medical", () => {
  assert.equal(med(base({ desc_en: "The formula cures quickly under both uv and led lamps." })), "PASS");
});
test("'cure your acne' (no jargon nearby) STILL triggers medical", () => {
  assert.equal(med(base({ desc_en: "This serum will cure your acne overnight." })), "BLOCK");
});
test("'miracle cure' (no jargon) STILL triggers medical", () => {
  assert.equal(med(base({ desc_en: "A miracle cure for eczema and rosacea." })), "BLOCK");
});
