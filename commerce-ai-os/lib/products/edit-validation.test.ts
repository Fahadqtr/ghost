// Tests for the V2 product-editor validation + fixed-message mapping
// (Phase UI.4). PURE — no database, no network.
// Run: node --conditions=react-server --experimental-strip-types --test lib/products/edit-validation.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { EDIT_MESSAGES, editFailureMessage, validateProductEditInput } from "./edit-validation.ts";
import { VARIANT_SYNC_MESSAGES, type ProductInput, type VariantInput } from "./product-save.ts";

function variant(over: Partial<VariantInput> = {}): VariantInput {
  return {
    variant_name: "وردي",
    variant_name_en: "Pink",
    sku: "V-1",
    barcode: "",
    color: "",
    size: "",
    price: "",
    stock_quantity: "",
    ...over,
  };
}

function input(over: Partial<ProductInput> = {}): ProductInput {
  return {
    sku: "P-1",
    barcode: "",
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
    input({ variants: [variant(), variant({ price: "12,5" })] }),
  );
  assert.ok(!res.ok);
  if (!res.ok) {
    assert.equal(res.message, EDIT_MESSAGES.invalid_number);
    assert.equal(res.field, "edit-variant-1-price");
  }
});

test("validation: a duplicated variant id in the payload is rejected with the fixed message", () => {
  const res = validateProductEditInput(
    input({ variants: [variant({ id: "va" }), variant({ id: "va", sku: "V-2" })] }),
  );
  assert.ok(!res.ok);
  if (!res.ok) {
    assert.equal(res.message, EDIT_MESSAGES.duplicate_variant_row);
    assert.equal(res.field, "edit-variants");
    assert.ok(!res.message.includes("va"), "never echoes the id");
  }
});

test("validation: multiple id-less new rows are NOT treated as duplicates", () => {
  assert.ok(validateProductEditInput(input({ variants: [variant(), variant({ sku: "V-2" })] })).ok);
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
