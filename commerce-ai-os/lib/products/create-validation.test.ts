// Tests for the AI-creator validation + fixed messages (Phase UI.5). PURE.
// Run: node --conditions=react-server --experimental-strip-types --test lib/products/create-validation.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { CREATE_MESSAGES, validateAiProductInput } from "./create-validation.ts";
import type { ProductInput, VariantInput } from "./product-save.ts";

const GOOD_BARCODE = "4006381333931";
const GOOD_BARCODE_2 = "4006381333948"; // 400638133394 + check 8

function variant(over: Partial<VariantInput> = {}): VariantInput {
  return {
    variant_name: "وردي", variant_name_en: "Pink", sku: "mk9-1",
    barcode: GOOD_BARCODE_2, color: "", size: "", price: "", stock_quantity: "",
    ...over,
  };
}

function input(over: Partial<ProductInput> = {}): ProductInput {
  return {
    sku: "mk9", barcode: GOOD_BARCODE, name_en: "Serum", name_ar: "سيروم",
    brand_id: "", main_category: "Korean Skincare", sub_category: "",
    product_type: "", color: "", size: "", price: "120", discount_price: "",
    cost: "", stock_quantity: "", stock_status: "", platform_status: "",
    approval: "", rejection_reason: "", image_filename: "", image_url: "",
    description_en: "", description_ar: "", keywords_en: "", keywords_ar: "",
    notes: "", variants: [],
    ...over,
  };
}

test("valid input passes, with and without variants", () => {
  assert.ok(validateAiProductInput(input()).ok);
  assert.ok(validateAiProductInput(input({ variants: [variant()] })).ok);
});

test("required: a name in either language and a category from the list", () => {
  const noName = validateAiProductInput(input({ name_ar: " ", name_en: "" }));
  assert.ok(!noName.ok && noName.message === CREATE_MESSAGES.name_required);
  const noCat = validateAiProductInput(input({ main_category: "" }));
  assert.ok(!noCat.ok && noCat.message === CREATE_MESSAGES.category_required);
});

test("SKU shape: mk<number> only; variant SKU must be <main>-n", () => {
  for (const bad of ["PRD1", "mk", "mk1a", ""]) {
    const r = validateAiProductInput(input({ sku: bad }));
    assert.ok(!r.ok && r.message === CREATE_MESSAGES.invalid_sku, bad);
  }
  for (const bad of ["mk9-01", "mk9-A", "mk8-1", "mk9", "mk9-0"]) {
    const r = validateAiProductInput(input({ variants: [variant({ sku: bad })] }));
    assert.ok(!r.ok && r.message === CREATE_MESSAGES.invalid_variant_sku, bad);
  }
});

test("barcodes must be real EAN-13s (check digit verified)", () => {
  const wrongCheck = validateAiProductInput(input({ barcode: "4006381333930" }));
  assert.ok(!wrongCheck.ok && wrongCheck.message === CREATE_MESSAGES.invalid_barcode);
  const short = validateAiProductInput(input({ variants: [variant({ barcode: "123" })] }));
  assert.ok(!short.ok && short.message === CREATE_MESSAGES.invalid_barcode);
});

test("in-form duplicates (sku or barcode repeated) are rejected with a focusable field", () => {
  const dupSku = validateAiProductInput(
    input({ variants: [variant(), variant({ barcode: "9312345678907" })] }),
  );
  assert.ok(!dupSku.ok);
  if (!dupSku.ok) {
    assert.equal(dupSku.message, CREATE_MESSAGES.duplicate_in_form);
    assert.equal(dupSku.field, "create-variant-1-sku");
  }
  const dupBarcode = validateAiProductInput(
    input({ variants: [variant(), variant({ sku: "mk9-2", barcode: GOOD_BARCODE_2 })] }),
  );
  assert.ok(!dupBarcode.ok && dupBarcode.message === CREATE_MESSAGES.duplicate_in_form);
  const productBarcodeReused = validateAiProductInput(
    input({ variants: [variant({ barcode: GOOD_BARCODE })] }),
  );
  assert.ok(!productBarcodeReused.ok && productBarcodeReused.message === CREATE_MESSAGES.duplicate_in_form);
});

test("numbers: junk and negatives rejected on product and variant fields", () => {
  const junk = validateAiProductInput(input({ price: "abc" }));
  assert.ok(!junk.ok && junk.message === CREATE_MESSAGES.invalid_number);
  const neg = validateAiProductInput(input({ variants: [variant({ price: "-2" })] }));
  assert.ok(!neg.ok && neg.message === CREATE_MESSAGES.negative_number);
});

test("every message is a fixed constant with no metacharacters and no interpolation", () => {
  for (const [key, value] of Object.entries(CREATE_MESSAGES)) {
    assert.equal(typeof value, "string", key);
    assert.ok(value.length > 0, key);
    assert.ok(!/[<>{}$`]/.test(value), `${key} clean`);
  }
  const r = validateAiProductInput(input({ sku: "DROP TABLE products" }));
  assert.ok(!r.ok && !r.message.includes("DROP"), "input text never echoed");
});
