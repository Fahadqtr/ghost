// UX.4D-2 — form adapter tests + source-scan guards for the propose-only action
// and the AI-fill component. PURE — no database, no network, no model.
//
// Run: node --conditions=react-server --experimental-strip-types --test lib/products/product-generation-form.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  PROPOSAL_FIELD_LABELS,
  PROPOSAL_SCALAR_MAP,
  planFillForm,
} from "./product-generation-form.ts";
import { PRODUCT_GENERATION_FIELDS, type ProductGenerationProposal } from "./product-generation.ts";

const BRANDS = [{ id: "b1", name: "Cosrx" }, { id: "b2", name: "Rhode" }];

// ── adapter: fill-missing ────────────────────────────────────────────────────

test("fill-missing: fills only blank scalars; resolves brand when missing + matched", () => {
  const scalars = { name_ar: "", name_en: "Existing EN", main_category: "", brand_id: "" };
  const proposal: ProductGenerationProposal = {
    nameAr: "اسم جديد", nameEn: "New EN", mainCategory: "Makeup", brand: "Cosrx", confidence: "high",
  };
  const plan = planFillForm(scalars, proposal, BRANDS);
  assert.equal(plan.patch.name_ar, "اسم جديد");
  assert.equal(plan.patch.main_category, "Makeup");
  assert.equal(plan.patch.brand_id, "b1", "brand name resolved to id");
  assert.equal("name_en" in plan.patch, false, "existing English name untouched");
  assert.equal(plan.brandMatched, true);
  assert.equal(plan.reviewRequired, false);
});

test("fill-missing: an existing brand_id is not overwritten", () => {
  const plan = planFillForm({ brand_id: "b2" }, { brand: "Cosrx", confidence: "high" }, BRANDS);
  assert.equal("brand_id" in plan.patch, false, "brand already set → not overwritten");
});

// ── adapter: overwrite-selected ──────────────────────────────────────────────

test("overwrite-selected: applies only chosen fields (incl. brand), even when filled", () => {
  const scalars = { name_ar: "قديم", name_en: "old", brand_id: "b2" };
  const proposal: ProductGenerationProposal = { nameAr: "A", nameEn: "B", brand: "Cosrx", confidence: "high" };
  const plan = planFillForm(scalars, proposal, BRANDS, { mode: "overwrite-selected", fields: ["nameEn", "brand"] });
  assert.equal(plan.patch.name_en, "B", "chosen overwritten");
  assert.equal(plan.patch.brand_id, "b1", "chosen brand overwritten");
  assert.equal("name_ar" in plan.patch, false, "unchosen untouched");
});

// ── adapter: brand safety ────────────────────────────────────────────────────

test("brand: an unknown brand name never invents a brand_id", () => {
  const plan = planFillForm({ brand_id: "" }, { brand: "NoSuchBrand", nameAr: "x", confidence: "high" }, BRANDS);
  assert.equal("brand_id" in plan.patch, false, "no invented id");
  assert.equal(plan.brandMatched, false);
  assert.ok(plan.skipped.includes("brand"));
  assert.equal(plan.patch.name_ar, "x", "other fields still fill");
});

// ── adapter: low confidence ──────────────────────────────────────────────────

test("low confidence: fill-missing applies nothing and flags reviewRequired", () => {
  const plan = planFillForm({ name_ar: "", brand_id: "" }, { nameAr: "x", brand: "Cosrx", confidence: "low" }, BRANDS);
  assert.deepEqual(plan.patch, {}, "nothing auto-applied");
  assert.equal(plan.reviewRequired, true);
});

// ── adapter: identity/commerce impossible ────────────────────────────────────

test("adapter never emits identity/commerce scalar keys", () => {
  const hostile = { nameAr: "ok", sku: "mk1", price: "5", barcode: "123", cost: "2" } as unknown as ProductGenerationProposal;
  const plan = planFillForm({}, hostile, BRANDS);
  for (const bad of ["sku", "barcode", "price", "discount_price", "cost", "stock_quantity", "approval", "platform_status", "image_url"]) {
    assert.equal(bad in plan.patch, false, `${bad} can never be in the patch`);
  }
  assert.equal(plan.patch.name_ar, "ok");
});

test("mapping + labels cover every proposal field", () => {
  for (const f of PRODUCT_GENERATION_FIELDS) {
    assert.ok(PROPOSAL_FIELD_LABELS[f], `label for ${f}`);
    if (f !== "brand") {
      assert.ok((PROPOSAL_SCALAR_MAP as Record<string, string>)[f], `scalar key for ${f}`);
    }
  }
});

test("adapter is deterministic", () => {
  const s = { name_ar: "", brand_id: "" };
  const p: ProductGenerationProposal = { nameAr: "a", brand: "Rhode", confidence: "high" };
  assert.deepEqual(planFillForm(s, p, BRANDS), planFillForm(s, p, BRANDS));
});

// ── guards: server action is propose-only ────────────────────────────────────

function src(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), "utf8");
}
const ACTION = src("../../app/(v2)/v2/catalog/generation-actions.ts");
const COMPONENT = src("../../components/v2/catalog/AiFillMissing.tsx");
const FORM = src("../../components/v2/catalog/ProductEditForm.tsx");

test("action: PROPOSE-ONLY — reuses enrich prompt/parser, never writes, never calls enrichProduct", () => {
  assert.ok(ACTION.startsWith('"use server"'), "server action");
  assert.ok(ACTION.includes("isSignedIn"), "auth gated");
  assert.ok(ACTION.includes("buildEnrichPrompt"), "reuses the existing prompt");
  assert.ok(ACTION.includes("parseEnrichResult"), "reuses the existing parser");
  assert.ok(ACTION.includes("assertSafeImageUrl"), "SSRF guard on the image");
  assert.ok(ACTION.includes("toProductGenerationProposal"), "returns a proposal via the shared mapper");
  for (const bad of [".update(", ".insert(", ".upsert(", ".delete(", ".rpc(", "createAdminClient", '.from("']) {
    assert.equal(ACTION.includes(bad), false, `propose-only action must not contain ${bad}`);
  }
  assert.equal(ACTION.includes("enrichProduct"), false, "never calls the DB-writing enrich action");
  // No re-implemented prompt text.
  assert.equal(ACTION.includes("أرجِع JSON"), false, "does not duplicate the prompt");
});

test("component: uses the shared plan/action, no direct DB/storage, no save", () => {
  assert.ok(COMPONENT.startsWith('"use client"'), "client component");
  assert.ok(COMPONENT.includes("generateProductFillProposal"), "calls the propose-only action");
  assert.ok(COMPONENT.includes("planFillForm"), "delegates fill logic to the pure adapter");
  assert.ok(COMPONENT.includes("✨ إكمال البيانات الناقصة"), "the fill button");
  assert.ok(COMPONENT.includes("تطبيق البيانات الناقصة") && COMPONENT.includes("تطبيق المحدد"), "apply-missing + apply-selected");
  for (const bad of ["@/lib/supabase", "@supabase/", ".storage", ".update(", ".insert(", "saveProductEdit", "createClient"]) {
    assert.equal(COMPONENT.includes(bad), false, `component must not contain ${bad}`);
  }
});

test("form: renders AiFillMissing and applies patches to scalars (completeness follows)", () => {
  assert.ok(FORM.includes("AiFillMissing"), "renders the panel");
  assert.ok(FORM.includes("applyAiPatch"), "apply handler");
  assert.ok(FORM.includes("onApply={applyAiPatch}"), "wired");
  // The patch is merged into scalars, which the completeness widget reads.
  assert.ok(FORM.includes("setScalars((s) => {"), "patch merged into scalars");
  assert.ok(FORM.includes('hasImage: (scalars.image_url ?? "").trim() !== ""'), "completeness reads scalars (unchanged rules)");
});
