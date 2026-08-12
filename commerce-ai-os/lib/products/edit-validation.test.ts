// Tests for the V2 product-editor validation + fixed-message mapping
// (Phase UI.4; validation parity adopted in UX.4E-3). PURE — no DB, no network.
// Run: node --conditions=react-server --experimental-strip-types --test lib/products/edit-validation.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { EDIT_MESSAGES, editFailureMessage, validateProductEditInput } from "./edit-validation.ts";
import { VARIANT_SYNC_MESSAGES, type ProductInput, type VariantInput } from "./product-save.ts";

// Real EAN-13s (verified check digit) — since UX.4E-3 the editor enforces the
// same SKU/barcode/EAN rules the creator does, so fixtures must be valid.
const GOOD_BARCODE = "4006381333931";
const GOOD_BARCODE_2 = "4006381333948";
const GOOD_BARCODE_3 = "9312345678907";

function variant(over: Partial<VariantInput> = {}): VariantInput {
  return {
    variant_name: "وردي",
    variant_name_en: "Pink",
    sku: "mk9-1",
    barcode: GOOD_BARCODE_2,
    color: "",
    size: "",
    price: "",
    stock_quantity: "",
    ...over,
  };
}

function input(over: Partial<ProductInput> = {}): ProductInput {
  return {
    sku: "mk9",
    barcode: GOOD_BARCODE,
    name_en: "Serum",
    name_ar: "سيروم",
    brand_id: "",
    main_category: "",
    sub_category: "",
    product_type: "",
    color: "",
    size: "",
    price: "",
    discount_price: "",
    cost: "",
    stock_quantity: "",
    stock_status: "",
    platform_status: "",
    approval: "",
    rejection_reason: "",
    image_filename: "",
    image_url: "",
    description_en: "",
    description_ar: "",
    keywords_en: "",
    keywords_ar: "",
    notes: "",
    variants: [],
    ...over,
  };
}

// ── validateProductEditInput ─────────────────────────────────────────────────

test("validation: valid input passes, with and without variants", () => {
  assert.ok(validateProductEditInput(input()).ok);
  assert.ok(validateProductEditInput(input({ variants: [variant()] })).ok);
});

test("validation: a name in either language is enough; both blank fails with a focusable field", () => {
  assert.ok(validateProductEditInput(input({ name_ar: "سيروم", name_en: "" })).ok);
  assert.ok(validateProductEditInput(input({ name_ar: "", name_en: "Serum" })).ok);
  const res = validateProductEditInput(input({ name_ar: "  ", name_en: "" }));
  assert.ok(!res.ok);
  if (!res.ok) {
    assert.equal(res.message, EDIT_MESSAGES.name_required);
    assert.equal(res.field, "edit-name_ar");
  }
});

test("validation: junk in a product number field fails with the fixed message and that field's id", () => {
  for (const f of ["price", "discount_price", "cost", "stock_quantity"] as const) {
    const res = validateProductEditInput(input({ [f]: "abc" } as Partial<ProductInput>));
    assert.ok(!res.ok, f);
    if (!res.ok) {
      assert.equal(res.message, EDIT_MESSAGES.invalid_number);
      assert.equal(res.field, `edit-${f}`);
      assert.ok(!res.message.includes("abc"), "never echoes the value");
    }
  }
});

test("validation: negative numbers are rejected; blanks and decimals are fine", () => {
  const neg = validateProductEditInput(input({ price: "-5" }));
  assert.ok(!neg.ok);
  if (!neg.ok) assert.equal(neg.message, EDIT_MESSAGES.negative_number);
  assert.ok(validateProductEditInput(input({ price: "", cost: "12.5", stock_quantity: "0" })).ok);
});

test("validation: variant number fields are checked by PAYLOAD index", () => {
  const res = validateProductEditInput(
    input({ variants: [variant(), variant({ sku: "mk9-2", barcode: GOOD_BARCODE_3, price: "12,5" })] }),
  );
  assert.ok(!res.ok);
  if (!res.ok) {
    assert.equal(res.message, EDIT_MESSAGES.invalid_number);
    assert.equal(res.field, "edit-variant-1-price");
  }
});

test("validation: a duplicated variant id in the payload is rejected with the fixed message", () => {
  const res = validateProductEditInput(
    input({ variants: [variant({ id: "va" }), variant({ id: "va", sku: "mk9-2", barcode: GOOD_BARCODE_3 })] }),
  );
  assert.ok(!res.ok);
  if (!res.ok) {
    assert.equal(res.message, EDIT_MESSAGES.duplicate_variant_row);
    assert.equal(res.field, "edit-variants");
    assert.ok(!res.message.includes("va"), "never echoes the id");
  }
});

test("validation: multiple id-less new rows are NOT treated as duplicates", () => {
  assert.ok(
    validateProductEditInput(input({ variants: [variant(), variant({ sku: "mk9-2", barcode: GOOD_BARCODE_3 })] })).ok,
  );
});

// ── UX.4E-3 parity: the SKU / barcode / EAN / in-form-duplicate rules ─────────

test("parity: main SKU must be mk<number> and main barcode must be a real EAN-13", () => {
  const badSku = validateProductEditInput(input({ sku: "P-1" }));
  assert.ok(!badSku.ok);
  if (!badSku.ok) {
    assert.equal(badSku.message, EDIT_MESSAGES.invalid_sku);
    assert.equal(badSku.field, "edit-sku");
  }
  const badBarcode = validateProductEditInput(input({ barcode: "4006381333930" }));
  assert.ok(!badBarcode.ok);
  if (!badBarcode.ok) {
    assert.equal(badBarcode.message, EDIT_MESSAGES.invalid_barcode);
    assert.equal(badBarcode.field, "edit-barcode");
  }
});

test("parity: variant SKU must be <main>-n and variant barcode must be EAN-13", () => {
  for (const bad of ["mk9", "mk9-0", "mk8-1", "mk9-A", "V-1"]) {
    const r = validateProductEditInput(input({ variants: [variant({ sku: bad })] }));
    assert.ok(!r.ok && r.message === EDIT_MESSAGES.invalid_variant_sku, bad);
    if (!r.ok) assert.equal(r.field, "edit-variant-0-sku");
  }
  const shortBarcode = validateProductEditInput(input({ variants: [variant({ barcode: "123" })] }));
  assert.ok(!shortBarcode.ok);
  if (!shortBarcode.ok) {
    assert.equal(shortBarcode.message, EDIT_MESSAGES.invalid_barcode);
    assert.equal(shortBarcode.field, "edit-variant-0-barcode");
  }
});

test("parity: in-form duplicate SKU/barcode (incl. reuse of the product's own) is rejected", () => {
  const dupSku = validateProductEditInput(
    input({ variants: [variant(), variant({ barcode: GOOD_BARCODE_3 })] }),
  );
  assert.ok(!dupSku.ok);
  if (!dupSku.ok) {
    assert.equal(dupSku.message, EDIT_MESSAGES.duplicate_in_form);
    assert.equal(dupSku.field, "edit-variant-1-sku");
  }
  const productBarcodeReused = validateProductEditInput(
    input({ variants: [variant({ barcode: GOOD_BARCODE })] }),
  );
  assert.ok(!productBarcodeReused.ok && productBarcodeReused.message === EDIT_MESSAGES.duplicate_in_form);
});

// ── editFailureMessage: fixed Arabic only, raw text never passes through ─────

test("mapping: invalid_input / product_update / inventory_sync map to fixed constants", () => {
  assert.equal(
    editFailureMessage({ stage: "invalid_input", message: 'Invalid category "Weapons".' }),
    EDIT_MESSAGES.invalid_input,
  );
  assert.equal(
    editFailureMessage({ stage: "product_update", message: "raw db text" }),
    EDIT_MESSAGES.product_update_failed,
  );
  assert.equal(
    editFailureMessage({ stage: "inventory_sync", message: "Product saved, but stock sync failed: boom" }),
    EDIT_MESSAGES.inventory_sync_failed,
  );
});

test("mapping: duplicate SKU/barcode gets its specific fixed Arabic message", () => {
  assert.equal(
    editFailureMessage({ stage: "product_update", message: "…", duplicateIdentity: true }),
    EDIT_MESSAGES.duplicate_identity,
  );
});

test("mapping: variant_sync messages pass through — they ARE the fixed constants", () => {
  for (const code of Object.keys(VARIANT_SYNC_MESSAGES)) {
    const msg = VARIANT_SYNC_MESSAGES[code];
    assert.equal(editFailureMessage({ stage: "variant_sync", message: msg }), msg);
  }
});

test("mapping: raw database text (SQLSTATE, constraint names, stacks) never survives a non-variant stage", () => {
  const hostile = 'SQLSTATE 23505: duplicate key value violates unique constraint "products_sku_key"\n  at handler';
  for (const stage of ["invalid_input", "product_update", "inventory_sync"] as const) {
    const out = editFailureMessage({ stage, message: hostile });
    assert.ok(!out.includes("SQLSTATE"), stage);
    assert.ok(!out.includes("constraint"), stage);
    assert.ok(!out.includes("at handler"), stage);
  }
});

test("messages: every EDIT_MESSAGES value is a fixed, non-empty Arabic-safe constant", () => {
  for (const [key, value] of Object.entries(EDIT_MESSAGES)) {
    assert.equal(typeof value, "string", key);
    assert.ok(value.length > 0, key);
    assert.ok(!/[<>{}$`]/.test(value), `${key} contains no template/HTML metacharacters`);
  }
});
