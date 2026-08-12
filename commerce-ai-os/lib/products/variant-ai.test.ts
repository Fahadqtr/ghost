// UX.4E-6 — pure AI variant-suggestion layer. Proves normalization, dedupe,
// deterministic order, proposal-only merge behavior, and the persisted-identity
// safety rules. PURE — no DB, no network, no React, no AI. Run:
//   node --conditions=react-server --experimental-strip-types --test lib/products/variant-ai.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  toVariantSuggestions,
  mergeVariantSuggestions,
  suggestionsPreselected,
  type VariantSuggestion,
} from "./variant-ai.ts";
import { makeVariantRow } from "./variant-model.ts";
import type { VisionExtract } from "./ai-extract.ts";

function read(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), "utf8");
}

function extract(variants: VisionExtract["variants"]): Pick<VisionExtract, "variants"> {
  return { variants };
}

// ── toVariantSuggestions ─────────────────────────────────────────────────────

test("toVariantSuggestions: normalizes (trims) the four trusted fields", () => {
  const out = toVariantSuggestions(extract([
    { variant_name: "  وردي ", variant_name_en: " Pink ", color: " فوشيا ", size: " 5g " },
  ]));
  assert.deepEqual(out, [{ variant_name: "وردي", variant_name_en: "Pink", color: "فوشيا", size: "5g" }]);
});

test("toVariantSuggestions: drops fully-blank suggestions", () => {
  const out = toVariantSuggestions(extract([
    { variant_name: "  ", variant_name_en: "", color: "", size: "" },
    { variant_name: "أحمر", variant_name_en: "", color: "", size: "" },
  ]));
  assert.deepEqual(out.map((s) => s.variant_name), ["أحمر"]);
});

test("toVariantSuggestions: collapses equivalent (case-insensitive) duplicates, first wins", () => {
  const out = toVariantSuggestions(extract([
    { variant_name: "Red", variant_name_en: "Red", color: "red", size: "" },
    { variant_name: "Red", variant_name_en: "RED", color: "RED", size: "" }, // equivalent
    { variant_name: "Blue", variant_name_en: "Blue", color: "blue", size: "" },
  ]));
  assert.deepEqual(out.map((s) => s.variant_name), ["Red", "Blue"]);
});

test("toVariantSuggestions: order is deterministic (preserves input order)", () => {
  const out = toVariantSuggestions(extract([
    { variant_name: "C", variant_name_en: "", color: "", size: "" },
    { variant_name: "A", variant_name_en: "", color: "", size: "" },
    { variant_name: "B", variant_name_en: "", color: "", size: "" },
  ]));
  assert.deepEqual(out.map((s) => s.variant_name), ["C", "A", "B"]);
});

test("toVariantSuggestions: null/empty extract is safe → []", () => {
  assert.deepEqual(toVariantSuggestions(null), []);
  assert.deepEqual(toVariantSuggestions(undefined), []);
  assert.deepEqual(toVariantSuggestions(extract([])), []);
});

test("toVariantSuggestions: never produces a SKU or barcode field", () => {
  const out = toVariantSuggestions(extract([{ variant_name: "x", variant_name_en: "", color: "", size: "" }]));
  assert.ok(!("sku" in out[0]));
  assert.ok(!("barcode" in out[0]));
});

// ── mergeVariantSuggestions: append-new ──────────────────────────────────────

const SUGGESTIONS: VariantSuggestion[] = [
  { variant_name: "وردي", variant_name_en: "Pink", color: "فوشيا", size: "" },
  { variant_name: "أزرق", variant_name_en: "Blue", color: "أزرق", size: "" },
];

test("append-new: each suggestion becomes an id:null row with blank SKU/barcode/price/stock", () => {
  const out = mergeVariantSuggestions([], SUGGESTIONS, { mode: "append-new", keyFactory: (i) => `ai-${i}` });
  assert.equal(out.length, 2);
  for (const row of out) {
    assert.equal(row.id, null); // never a persisted id
    assert.equal(row.removed, false);
    assert.equal(row.fields.sku, ""); // no AI SKU
    assert.equal(row.fields.barcode, ""); // no AI barcode
    assert.equal(row.fields.price, ""); // no AI price
    assert.equal(row.fields.stock_quantity, ""); // no AI stock
  }
  assert.deepEqual(out.map((r) => [r.fields.variant_name, r.fields.variant_name_en, r.fields.color]), [
    ["وردي", "Pink", "فوشيا"],
    ["أزرق", "Blue", "أزرق"],
  ]);
  assert.deepEqual(out.map((r) => r.key), ["ai-0", "ai-1"]);
});

test("append-new: existing rows are untouched and persisted ids never change", () => {
  const existing = makeVariantRow("p1", { id: "db-uuid-1", fields: { sku: "mk9-1", barcode: "4006381333931", variant_name: "قديم" } });
  const out = mergeVariantSuggestions([existing], SUGGESTIONS, { mode: "append-new", keyFactory: (i) => `ai-${i}` });
  assert.equal(out.length, 3);
  assert.deepEqual(out[0], existing); // unchanged, same ref content
  assert.equal(out[0].id, "db-uuid-1");
  assert.equal(out[0].fields.sku, "mk9-1");
});

test("append-new: only the SELECTED suggestions passed in are applied", () => {
  // Caller filters selection; the merge appends exactly what it is given.
  const out = mergeVariantSuggestions([], [SUGGESTIONS[1]], { mode: "append-new" });
  assert.equal(out.length, 1);
  assert.equal(out[0].fields.variant_name, "أزرق");
});

// ── mergeVariantSuggestions: fill-missing-selected ───────────────────────────

test("fill-missing-selected: fills ONLY the blank name/color/size of the selected row", () => {
  const rows = [
    makeVariantRow("p1", { id: "db-1", fields: { sku: "mk9-1", barcode: "b1", variant_name: "", variant_name_en: "Existing", color: "", size: "10g" } }),
    makeVariantRow("p2", { id: "db-2", fields: { sku: "mk9-2", variant_name: "لا يمس" } }),
  ];
  const out = mergeVariantSuggestions(rows, [{ variant_name: "وردي", variant_name_en: "Pink", color: "فوشيا", size: "99g" }], {
    mode: "fill-missing-selected",
    selectedKey: "p1",
  });
  const p1 = out.find((r) => r.key === "p1")!;
  assert.equal(p1.fields.variant_name, "وردي"); // was blank → filled
  assert.equal(p1.fields.variant_name_en, "Existing"); // non-blank → NOT overwritten
  assert.equal(p1.fields.color, "فوشيا"); // filled
  assert.equal(p1.fields.size, "10g"); // non-blank → NOT overwritten
  assert.equal(p1.fields.sku, "mk9-1"); // identity untouched
  assert.equal(p1.fields.barcode, "b1");
  assert.equal(p1.id, "db-1"); // id never changes
  assert.deepEqual(out.find((r) => r.key === "p2"), rows[1]); // other rows untouched
});

test("fill-missing-selected: no-op without a suggestion or a selected key", () => {
  const rows = [makeVariantRow("p1", { id: "db-1", fields: { variant_name: "" } })];
  assert.deepEqual(mergeVariantSuggestions(rows, [], { mode: "fill-missing-selected", selectedKey: "p1" }), rows);
  assert.deepEqual(mergeVariantSuggestions(rows, SUGGESTIONS, { mode: "fill-missing-selected" }), rows);
});

// ── confidence ───────────────────────────────────────────────────────────────

test("suggestionsPreselected: high/medium preselect; low does NOT", () => {
  assert.equal(suggestionsPreselected("high"), true);
  assert.equal(suggestionsPreselected("medium"), true);
  assert.equal(suggestionsPreselected("low"), false);
});

// ── immutability ─────────────────────────────────────────────────────────────

test("no mutation: inputs are never mutated", () => {
  const rows = [makeVariantRow("p1", { id: "db-1", fields: { variant_name: "" } })];
  const before = JSON.stringify(rows);
  mergeVariantSuggestions(rows, SUGGESTIONS, { mode: "append-new" });
  mergeVariantSuggestions(rows, SUGGESTIONS, { mode: "fill-missing-selected", selectedKey: "p1" });
  const ext = extract([{ variant_name: " x ", variant_name_en: "", color: "", size: "" }]);
  toVariantSuggestions(ext);
  assert.equal(JSON.stringify(rows), before);
});

// ── source guards ────────────────────────────────────────────────────────────

test("guard: variant-ai is pure — no React/Supabase/server/AI-call/prompt", () => {
  const code = read("./variant-ai.ts");
  for (const forbidden of ['from "react"', "supabase", '"use client"', '"use server"', "Anthropic", "buildVisionExtractPrompt", "parseVisionExtract", "fetch("]) {
    assert.equal(code.includes(forbidden), false, `variant-ai must not contain ${forbidden}`);
  }
  assert.ok(code.includes('from "./variant-model.ts"'), "reuses the shared row model");
});

test("guard: variant-ai never creates SKU/barcode or validation logic", () => {
  const code = read("./variant-ai.ts");
  for (const forbidden of ["nextMkSku", "variantMkSku", "generateEan13", "isValidEan13", "validateProduct", "renumberVariantSkus"]) {
    assert.equal(code.includes(forbidden), false, `variant-ai must not use ${forbidden}`);
  }
});

test("guard: VariantAISuggestions reuses the existing AI action + pure layer, adds no prompt/parser/identity/validation", () => {
  const code = read("../../components/v2/catalog/VariantAISuggestions.tsx");
  assert.ok(code.includes("analyzeAiProductImage"), "reuses the existing propose-only AI action");
  assert.ok(code.includes("toVariantSuggestions"), "uses the pure suggestion layer");
  for (const forbidden of ["buildVisionExtractPrompt", "parseVisionExtract", "Anthropic", "nextMkSku", "generateEan13", "validateProduct", ".insert(", ".update(", "rpc("]) {
    assert.equal(code.includes(forbidden), false, `VariantAISuggestions must not contain ${forbidden}`);
  }
});

test("guard: Edit wires the AI layer; Create is left on its OWN path (unchanged)", () => {
  const edit = read("../../components/v2/catalog/ProductEditForm.tsx");
  assert.ok(edit.includes("VariantAISuggestions"), "Edit renders the AI suggestions component");
  assert.ok(edit.includes('from "@/lib/products/variant-ai"'), "Edit uses the pure merge layer");
  const create = read("../../components/v2/catalog/AiProductCreator.tsx");
  assert.equal(create.includes("variant-ai"), false, "Create does not import the new AI suggestion layer");
  assert.ok(create.includes("renumberVariantSkus"), "Create keeps its own extract→rows mapping");
});
