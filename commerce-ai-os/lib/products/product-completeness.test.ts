// UX.4A — Product completeness wrapper tests.
// PURE tests only — no database, no network, no rendering.
//
// Run: node --conditions=react-server --experimental-strip-types --test lib/products/product-completeness.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  completenessTone,
  computeProductCompleteness,
  COMPLETENESS_LABELS,
  type ProductCompletenessInput,
} from "./product-completeness.ts";
import { computeProductReadiness } from "../operations/readiness/readiness.ts";
import type { OperationsProduct } from "../operations/shared/models.ts";

/** A fully-complete (no-variant) product; override per test. */
function full(over: Partial<ProductCompletenessInput> = {}): ProductCompletenessInput {
  return {
    nameAr: "منتج",
    nameEn: "Product",
    sku: "mk123",
    barcode: "1234567890123", // 13 digits
    price: "10",
    category: "Makeup",
    brandId: "b1",
    descriptionAr: "وصف",
    hasImage: true,
    variantCount: 0,
    ...over,
  };
}

const checkByCode = (r: ReturnType<typeof computeProductCompleteness>, code: string) =>
  r.checks.find((c) => c.code === code);

// ── delegates to the readiness engine (no duplicated scoring) ────────────────

test("percent + checks come straight from the readiness engine", () => {
  const input = full({ brandId: "" }); // drop one optional
  const result = computeProductCompleteness(input);

  // Build the same OperationsProduct the wrapper builds and compare to readiness.
  const snapshot: OperationsProduct = {
    id: "",
    sku: "mk123",
    barcode: "1234567890123",
    nameAr: "منتج",
    nameEn: "Product",
    descriptionAr: "وصف",
    descriptionEn: null,
    brandId: null,
    category: "Makeup",
    price: 10,
    imageUrl: "1",
    approval: "",
    platformStatus: "",
    variantCount: 0,
    expectsVariants: undefined,
  };
  const readiness = computeProductReadiness(snapshot);
  assert.equal(result.percent, readiness.percent);
  assert.deepEqual(
    result.checks.map((c) => [c.code, c.passed, c.required]),
    readiness.checks.map((c) => [c.code, c.passed, c.required]),
  );
});

test("a fully-filled product scores 100 and every check passes", () => {
  const r = computeProductCompleteness(full());
  assert.equal(r.percent, 100);
  assert.equal(r.tone, "complete");
  assert.ok(r.checks.every((c) => c.passed));
});

// ── individual missing-field reflection ──────────────────────────────────────

test("missing image is reflected", () => {
  const r = computeProductCompleteness(full({ hasImage: false }));
  assert.equal(checkByCode(r, "image")!.passed, false);
  assert.ok(r.percent < 100);
});

test("missing SKU is reflected", () => {
  const r = computeProductCompleteness(full({ sku: "" }));
  assert.equal(checkByCode(r, "sku")!.passed, false);
});

test("invalid SKU (not mk<number>) is reflected as failing", () => {
  const r = computeProductCompleteness(full({ sku: "ABC-1" }));
  assert.equal(checkByCode(r, "sku")!.passed, false);
});

test("missing barcode is reflected", () => {
  const r = computeProductCompleteness(full({ barcode: "" }));
  assert.equal(checkByCode(r, "barcode")!.passed, false);
});

test("missing category is reflected", () => {
  const r = computeProductCompleteness(full({ category: "" }));
  assert.equal(checkByCode(r, "category")!.passed, false);
});

test("missing price is reflected (blank string ⇒ no valid price)", () => {
  const r = computeProductCompleteness(full({ price: "" }));
  assert.equal(checkByCode(r, "price")!.passed, false);
});

// ── description / brand optionality matches readiness ────────────────────────

test("description and brand are OPTIONAL (required:false) but still affect percent", () => {
  const desc = checkByCode(computeProductCompleteness(full()), "description")!;
  const brand = checkByCode(computeProductCompleteness(full()), "brand")!;
  assert.equal(desc.required, false);
  assert.equal(brand.required, false);
  // All required present, only the two optionals missing ⇒ 6/8 = 75, not blocked.
  const r = computeProductCompleteness(full({ descriptionAr: "", descriptionEn: "", brandId: "" }));
  assert.equal(checkByCode(r, "description")!.passed, false);
  assert.equal(checkByCode(r, "brand")!.passed, false);
  assert.equal(r.percent, 75);
  assert.equal(r.tone, "good");
});

// ── variants: only appears when the product has variants ─────────────────────

test("variants check only appears when variantCount > 0 (passes when present)", () => {
  assert.equal(checkByCode(computeProductCompleteness(full({ variantCount: 0 })), "variants"), undefined);
  const withVariants = computeProductCompleteness(full({ variantCount: 2 }));
  assert.equal(checkByCode(withVariants, "variants")!.passed, true);
});

// ── tone bands (presentation only) ───────────────────────────────────────────

test("tone bands: 100 complete, 70–99 good, <70 incomplete", () => {
  assert.equal(completenessTone(100), "complete");
  assert.equal(completenessTone(88), "good");
  assert.equal(completenessTone(70), "good");
  assert.equal(completenessTone(69), "incomplete");
  assert.equal(completenessTone(13), "incomplete");
});

test("a mostly-empty product is incomplete", () => {
  const r = computeProductCompleteness({ nameAr: "منتج" });
  assert.equal(r.tone, "incomplete");
  assert.ok(r.percent < 70);
});

// ── labels cover every readiness check code ──────────────────────────────────

test("every check carries an Arabic label", () => {
  const r = computeProductCompleteness(full({ variantCount: 1 }));
  for (const c of r.checks) {
    assert.equal(c.label, COMPLETENESS_LABELS[c.code]);
    assert.ok(c.label.length > 0);
  }
});

test("deterministic — same input yields the same result", () => {
  const i = full({ brandId: "" });
  assert.deepEqual(computeProductCompleteness(i), computeProductCompleteness(i));
});

// ── guards: no duplicated rules, no I/O, wired into BOTH forms ────────────────

test("wrapper does NOT re-implement readiness rules — it delegates", () => {
  const SRC = readFileSync(new URL("./product-completeness.ts", import.meta.url), "utf8");
  assert.ok(SRC.includes("computeProductReadiness"), "delegates to the readiness engine");
  // no re-implemented identifier regexes / check logic
  assert.equal(/\/\^mk/.test(SRC), false, "no re-implemented SKU regex");
  assert.equal(/\[0-9\]\{6,14\}/.test(SRC), false, "no re-implemented barcode regex");
});

test("wrapper + widget do no I/O, no AI, no writes", () => {
  const LIB = readFileSync(new URL("./product-completeness.ts", import.meta.url), "utf8");
  const UI = readFileSync(new URL("../../components/v2/catalog/ProductCompleteness.tsx", import.meta.url), "utf8");
  for (const src of [LIB, UI]) {
    for (const bad of ["createClient", "supabase", "fetch(", ".insert(", ".update(", ".rpc(", "anthropic", "gemini", "openai", "process.env"]) {
      assert.equal(src.toLowerCase().includes(bad.toLowerCase()), false, `must not contain ${bad}`);
    }
  }
});

test("the SAME wrapper + widget are used by BOTH create and edit forms", () => {
  const CREATE = readFileSync(new URL("../../components/v2/catalog/AiProductCreator.tsx", import.meta.url), "utf8");
  const EDIT = readFileSync(new URL("../../components/v2/catalog/ProductEditForm.tsx", import.meta.url), "utf8");
  for (const src of [CREATE, EDIT]) {
    assert.ok(src.includes("computeProductCompleteness"), "form computes completeness via the wrapper");
    assert.ok(src.includes("<ProductCompleteness"), "form renders the shared widget");
  }
});
