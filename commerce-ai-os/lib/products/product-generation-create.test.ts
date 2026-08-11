// UX.4D-3 — Create AI unification: seed-equivalence (VisionExtract → shared
// proposal → form scalars) + source-scan guards proving Create now shares the
// proposal layer / adapter / AiFillMissing while its analyze/identity/variants/
// create/rollback paths are untouched. PURE — no DB, no network, no model.
//
// Run: node --conditions=react-server --experimental-strip-types --test lib/products/product-generation-create.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { PRODUCT_GENERATION_FIELDS, toProductGenerationProposal } from "./product-generation.ts";
import { PROPOSAL_SCALAR_MAP } from "./product-generation-form.ts";
import type { VisionExtract } from "./ai-extract.ts";

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

/** Reproduce applyPrepared's content-seed loop (the exact code path in the
 *  create form) so the mapping is verified end-to-end without rendering. */
function seedScalars(x: VisionExtract): Record<string, string> {
  const proposal = toProductGenerationProposal(x, (x.visible_text ?? "").trim() ? "image+text" : "image");
  const patch: Record<string, string> = {};
  for (const f of PRODUCT_GENERATION_FIELDS) {
    if (f === "brand") continue;
    patch[PROPOSAL_SCALAR_MAP[f as Exclude<typeof f, "brand">]] = proposal[f] ?? "";
  }
  return patch;
}

// ── seed equivalence ─────────────────────────────────────────────────────────

test("create seed: VisionExtract maps to the same scalars as before (shade→color)", () => {
  const x = vision();
  const patch = seedScalars(x);
  assert.equal(patch.name_en, x.name_en);
  assert.equal(patch.name_ar, x.name_ar);
  assert.equal(patch.main_category, x.main_category);
  assert.equal(patch.product_type, x.product_type);
  assert.equal(patch.color, x.shade, "shade seeds the color scalar");
  assert.equal(patch.size, x.size);
  assert.equal(patch.description_en, x.description_en);
  assert.equal(patch.description_ar, x.description_ar);
  assert.equal(patch.keywords_en, x.keywords_en);
  assert.equal(patch.keywords_ar, x.keywords_ar);
});

test("create seed: blank extract fields seed empty scalars (overwrite preserved)", () => {
  const patch = seedScalars(vision({ product_type: "", shade: "", size: "" }));
  assert.equal(patch.product_type, "");
  assert.equal(patch.color, "");
  assert.equal(patch.size, "");
});

test("create seed never touches identity/commerce scalars", () => {
  const patch = seedScalars(vision());
  for (const bad of ["sku", "barcode", "price", "discount_price", "cost", "stock_quantity", "brand_id"]) {
    assert.equal(bad in patch, false, `${bad} is not seeded by the content proposal`);
  }
});

// ── source-scan guards ───────────────────────────────────────────────────────

function src(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), "utf8");
}
const CREATE = src("../../components/v2/catalog/AiProductCreator.tsx");
const EDIT = src("../../components/v2/catalog/ProductEditForm.tsx");
const CREATE_ACTIONS = src("../../app/(v2)/v2/catalog/new/actions.ts");

test("create form: shares the proposal layer, adapter, matcher, and AiFillMissing", () => {
  assert.ok(CREATE.includes("toProductGenerationProposal"), "maps VisionExtract via the shared mapper");
  assert.ok(CREATE.includes("PROPOSAL_SCALAR_MAP"), "uses the shared field map");
  assert.ok(CREATE.includes('from "@/lib/products/brand-match"'), "uses the shared brand matcher");
  assert.ok(CREATE.includes("<AiFillMissing"), "renders the shared AI-fill panel");
  assert.ok(CREATE.includes("applyAiPatch"), "applies via the shared patch merge");
  // The duplicated inline mapping is gone (no hardcoded VisionExtract→scalar list).
  assert.equal(CREATE.includes("brand_id: matchBrandId(brands, x.brand)"), false, "old inline mapping removed");
  // No local re-declaration of the matcher.
  assert.equal(/function matchBrandId\s*\(/.test(CREATE), false, "no duplicated matchBrandId");
});

test("create form: analyze / identity / variants / save paths unchanged", () => {
  assert.ok(CREATE.includes("analyzeAiProductImage"), "vision analysis unchanged");
  assert.ok(CREATE.includes("prepareAiProduct"), "identity scan unchanged");
  assert.ok(CREATE.includes("prepared.sku") && CREATE.includes("prepared.productBarcode"), "SKU/barcode seed unchanged");
  assert.ok(CREATE.includes("setRowsFromExtract"), "variant hints unchanged");
  assert.ok(CREATE.includes("createAiProduct"), "create/save path unchanged");
});

test("create form: no new DB/model access, no prompt duplication", () => {
  for (const bad of ["@/lib/supabase", "@supabase/", "Anthropic", ".update(", ".insert(", '.from("', ".rpc(", "createAdminClient"]) {
    assert.equal(CREATE.includes(bad), false, `create form must not contain ${bad}`);
  }
  assert.equal(CREATE.includes("أرجِع JSON"), false, "no prompt duplication");
  assert.equal(CREATE.includes("buildVisionExtractPrompt"), false, "no prompt building in the client");
});

test("create persistence action is untouched by this phase (still guards + no new writes beyond existing)", () => {
  // The create action still uploads the image + writes the product_images row via
  // the existing UX.4C-2 gap-closure; UX.4D-3 adds no write here.
  assert.ok(CREATE_ACTIONS.includes("createProductCore"), "create core unchanged");
  assert.ok(CREATE_ACTIONS.includes('.from("product_images")'), "existing gallery insert kept");
  assert.equal(CREATE_ACTIONS.includes("toProductGenerationProposal"), false, "the action gains no AI-proposal logic");
});

test("edit path unchanged: still renders the shared AiFillMissing + applyAiPatch", () => {
  assert.ok(EDIT.includes("<AiFillMissing"), "edit still uses the shared panel");
  assert.ok(EDIT.includes("applyAiPatch"), "edit apply handler intact");
});
