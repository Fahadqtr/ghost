import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProductCopyText } from "./copy-text.ts";

test("includes titles, codes, price and description", () => {
  const t = buildProductCopyText({
    name_en: "Rhode Lip Tint", name_ar: "صبغة شفاه رود",
    sku: "mk2084", barcode: "2900000001657", price: 219, discount_price: 199,
    main_category: "Makeup", sub_category: "Lips",
    description_en: "A glossy tint.", description_ar: "صبغة لامعة.",
  });
  assert.match(t, /Rhode Lip Tint/);
  assert.match(t, /صبغة شفاه رود/);
  assert.match(t, /SKU: mk2084/);
  assert.match(t, /2900000001657/);
  assert.match(t, /219.*بعد الخصم: 199/);
  assert.match(t, /Makeup › Lips/);
  assert.match(t, /A glossy tint\./);
  assert.match(t, /صبغة لامعة\./);
});

test("empty fields are skipped (no dangling labels)", () => {
  const t = buildProductCopyText({ name_en: "X", sku: "s1" });
  assert.doesNotMatch(t, /Barcode/);
  assert.doesNotMatch(t, /الوصف/);
  assert.doesNotMatch(t, /Options/);
});

test("lists every option with its codes", () => {
  const t = buildProductCopyText(
    { name_en: "Foundation" },
    [
      { variant_name: "Shade 01", sku: "mk1-01", barcode: "290...1", price: 60 },
      { variant_name: "Shade 02", sku: "mk1-02", barcode: "290...2", price: 60 },
    ],
  );
  assert.match(t, /Options \(2\)/);
  assert.match(t, /Shade 01 · SKU mk1-01 · باركود 290\.\.\.1 · السعر 60/);
  assert.match(t, /Shade 02 · SKU mk1-02/);
});

test("blank/whitespace variants are dropped", () => {
  const t = buildProductCopyText({ name_en: "Y" }, [{ variant_name: "  ", sku: "", barcode: "" }]);
  assert.doesNotMatch(t, /Options/);
});
