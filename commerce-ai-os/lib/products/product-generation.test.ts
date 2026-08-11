// UX.4D-1 — Unified AI proposal layer tests. PURE — no database, no network,
// no model call, no rendering.
//
// Run: node --conditions=react-server --experimental-strip-types --test lib/products/product-generation.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  PRODUCT_GENERATION_FIELDS,
  applyProductGenerationProposal,
  toProductGenerationProposal,
  type ProductGenerationField,
  type ProductGenerationProposal,
} from "./product-generation.ts";
import type { VisionExtract } from "./ai-extract.ts";
import type { ProductDraft } from "./draft-compute.ts";
import type { EnrichResult } from "./enrich-compute.ts";

// ── builders ─────────────────────────────────────────────────────────────────

function vision(over: Partial<VisionExtract> = {}): VisionExtract {
  return {
    brand: "Cosrx", name_en: "Cosrx Essence", name_ar: "سيروم كوزركس - Cosrx Essence",
    description_en: "desc en", description_ar: "وصف عربي",
    keywords_en: "cosrx, essence", keywords_ar: "كوزركس, سيروم",
    main_category: "Korean Skincare", product_type: "Serum", size: "100ml", shade: "Clear",
    model: "", country: "Korea", visible_text: "COSRX", has_variants: false, variants: [],
    confidence: "high", ...over,
  };
}

function draft(over: Partial<ProductDraft> = {}): ProductDraft {
  return {
    name_en: "Rhode Set", name_ar: "طقم رود - Rhode Set",
    description_en: "desc", description_ar: "وصف",
    keywords_en: "rhode, set", keywords_ar: "رود, طقم",
    main_category: "Rhode Products Section", variants: [], ...over,
  };
}

function enrich(over: Partial<EnrichResult> = {}): EnrichResult {
  return {
    name_ar: "اسم عربي - EN", description_ar: "وصف عربي", main_category: "Makeup",
    arMatchesEn: false, imageMatches: true, notes: "photo ok", ...over,
  };
}

// ── mapping ──────────────────────────────────────────────────────────────────

test("VisionExtract mapping: full content fields, shade→color, confidence + source carried", () => {
  const p = toProductGenerationProposal(vision(), "image");
  assert.equal(p.nameEn, "Cosrx Essence");
  assert.equal(p.nameAr, "سيروم كوزركس - Cosrx Essence");
  assert.equal(p.descriptionEn, "desc en");
  assert.equal(p.descriptionAr, "وصف عربي");
  assert.equal(p.brand, "Cosrx");
  assert.equal(p.mainCategory, "Korean Skincare");
  assert.equal(p.productType, "Serum");
  assert.equal(p.size, "100ml");
  assert.equal(p.color, "Clear", "shade maps to color");
  assert.equal(p.keywordsAr, "كوزركس, سيروم");
  assert.equal(p.confidence, "high");
  assert.equal(p.source, "image");
  // Vision-only, non-content fields never appear as product fields.
  assert.equal("visible_text" in p, false);
  assert.equal("model" in p, false);
});

test("ProductDraft mapping: content subset, NO brand/type/color/size, NO confidence", () => {
  const p = toProductGenerationProposal(draft(), "text");
  assert.equal(p.nameEn, "Rhode Set");
  assert.equal(p.descriptionAr, "وصف");
  assert.equal(p.mainCategory, "Rhode Products Section");
  assert.equal(p.keywordsEn, "rhode, set");
  assert.equal(p.brand, undefined);
  assert.equal(p.color, undefined);
  assert.equal(p.size, undefined);
  assert.equal(p.confidence, undefined, "draft has no confidence to carry");
  assert.equal(p.source, "text");
});

test("EnrichResult mapping: only ar-name/ar-description/category; verification signals dropped", () => {
  const p = toProductGenerationProposal(enrich(), "existing+image");
  assert.equal(p.nameAr, "اسم عربي - EN");
  assert.equal(p.descriptionAr, "وصف عربي");
  assert.equal(p.mainCategory, "Makeup");
  assert.equal(p.nameEn, undefined, "enrich has no English name");
  assert.equal(p.confidence, undefined);
  // arMatchesEn / imageMatches / notes are NOT product fields.
  const s = JSON.stringify(p);
  assert.ok(!s.includes("arMatchesEn") && !s.includes("imageMatches") && !s.includes("notes"));
});

test("mapping invents nothing: blank source fields are omitted, not emitted as empty", () => {
  const p = toProductGenerationProposal(vision({ size: "", shade: "  ", brand: "" }), "image");
  assert.equal("size" in p, false);
  assert.equal("color" in p, false);
  assert.equal("brand" in p, false);
});

test("confidence preserved exactly for each vision level", () => {
  assert.equal(toProductGenerationProposal(vision({ confidence: "medium" }), "image").confidence, "medium");
  assert.equal(toProductGenerationProposal(vision({ confidence: "low" }), "image").confidence, "low");
});

// ── apply: fill-missing ──────────────────────────────────────────────────────

test("fill-missing: fills only blank fields; existing values untouched", () => {
  const proposal: ProductGenerationProposal = { nameAr: "جديد", nameEn: "New", confidence: "high" };
  const res = applyProductGenerationProposal({ nameAr: "", nameEn: "Existing" }, proposal);
  assert.equal(res.next.nameAr, "جديد", "blank filled");
  assert.equal(res.next.nameEn, "Existing", "existing kept");
  assert.deepEqual(res.applied, ["nameAr"]);
  assert.deepEqual(res.skipped, ["nameEn"]);
  assert.equal(res.reviewRequired, false);
});

test("fill-missing: whitespace-only current is treated as empty", () => {
  const res = applyProductGenerationProposal({ color: "   " }, { color: "Red", confidence: "high" });
  assert.equal(res.next.color, "Red");
  assert.deepEqual(res.applied, ["color"]);
});

test("fill-missing: an empty proposal never clears a current value", () => {
  const res = applyProductGenerationProposal({ nameAr: "موجود" }, { confidence: "high" });
  assert.equal(res.next.nameAr, "موجود");
  assert.deepEqual(res.applied, []);
  assert.deepEqual(res.skipped, []);
});

// ── apply: overwrite-selected ────────────────────────────────────────────────

test("overwrite-selected: applies ONLY the chosen fields, even over filled ones", () => {
  const proposal: ProductGenerationProposal = { nameAr: "A", nameEn: "B", size: "50ml", confidence: "high" };
  const res = applyProductGenerationProposal(
    { nameAr: "old", nameEn: "old-en", size: "old-size" },
    proposal,
    { mode: "overwrite-selected", fields: ["nameAr", "size"] },
  );
  assert.equal(res.next.nameAr, "A", "chosen overwritten");
  assert.equal(res.next.size, "50ml", "chosen overwritten");
  assert.equal(res.next.nameEn, "old-en", "unchosen untouched (no blanket overwrite)");
  assert.deepEqual(res.applied.sort(), ["nameAr", "size"]);
  assert.ok(res.skipped.includes("nameEn"));
});

test("overwrite-selected with no fields list applies nothing", () => {
  const res = applyProductGenerationProposal({ nameAr: "old" }, { nameAr: "A", confidence: "high" }, { mode: "overwrite-selected" });
  assert.deepEqual(res.applied, []);
  assert.equal(res.next.nameAr, "old");
});

// ── apply: low confidence ────────────────────────────────────────────────────

test("low confidence: fill-missing applies NOTHING and flags reviewRequired", () => {
  const proposal: ProductGenerationProposal = { nameAr: "x", descriptionAr: "y", confidence: "low" };
  const res = applyProductGenerationProposal({ nameAr: "", descriptionAr: "" }, proposal);
  assert.deepEqual(res.applied, [], "no auto-apply on low confidence");
  assert.deepEqual(res.skipped.sort(), ["descriptionAr", "nameAr"]);
  assert.equal(res.next.nameAr, "", "unchanged");
  assert.equal(res.reviewRequired, true);
});

test("low confidence: an EXPLICIT overwrite-selected is still honored (not auto)", () => {
  const res = applyProductGenerationProposal(
    { nameAr: "" },
    { nameAr: "chosen", confidence: "low" },
    { mode: "overwrite-selected", fields: ["nameAr"] },
  );
  assert.deepEqual(res.applied, ["nameAr"]);
  assert.equal(res.reviewRequired, true, "still flagged for review");
});

// ── contract safety + determinism ────────────────────────────────────────────

test("contract cannot carry identity/commerce/image fields", () => {
  for (const banned of ["sku", "barcode", "price", "discountPrice", "cost", "stock", "approval", "platformStatus", "imageUrl", "imageFilename"]) {
    assert.equal((PRODUCT_GENERATION_FIELDS as readonly string[]).includes(banned), false, `${banned} is not applyable`);
  }
  // Even if a hostile proposal smuggles such keys, apply ignores them entirely.
  const hostile = { nameAr: "ok", sku: "mk999", price: "5", stock_quantity: "9" } as unknown as ProductGenerationProposal;
  const res = applyProductGenerationProposal({}, hostile);
  assert.equal("sku" in res.next, false);
  assert.equal("price" in res.next, false);
  assert.deepEqual(res.applied, ["nameAr"]);
});

test("apply is deterministic — same inputs yield the same result", () => {
  const cur: Partial<Record<ProductGenerationField, string>> = { nameAr: "", nameEn: "keep" };
  const prop: ProductGenerationProposal = { nameAr: "a", nameEn: "b", confidence: "high" };
  assert.deepEqual(applyProductGenerationProposal(cur, prop), applyProductGenerationProposal(cur, prop));
});

// ── guard: pure, no I/O, no model, no prompt duplication ──────────────────────

test("module is PURE: no supabase / model SDK / fetch / server / write / prompt", () => {
  const SRC = readFileSync(new URL("./product-generation.ts", import.meta.url), "utf8");
  for (const bad of [
    "@supabase", "supabase", "Anthropic", "anthropic", "openai", "OpenAI", "gemini", "generativelanguage",
    "fetch(", '"use server"', ".from(", ".insert(", ".update(", ".upsert(", ".delete(", ".rpc(", ".storage",
    "createClient", "createAdminClient",
  ]) {
    assert.equal(SRC.includes(bad), false, `pure layer must not contain ${bad}`);
  }
  // No prompt duplication: it must not re-implement or call the existing prompts/parsers.
  for (const bad of [
    "buildVisionExtractPrompt", "buildDraftPrompt", "buildEnrichPrompt",
    "parseVisionExtract", "parseProductDraft", "parseEnrichResult",
    "أرجِع JSON", "HOUSE_STYLE_EXAMPLE",
  ]) {
    assert.equal(SRC.includes(bad), false, `must not duplicate/call prompts (${bad})`);
  }
  // Sources are pulled as TYPES only (erased) — no value import of the AI engines.
  assert.ok(/import type \{[^}]*VisionExtract/.test(SRC), "VisionExtract imported as a type");
});
