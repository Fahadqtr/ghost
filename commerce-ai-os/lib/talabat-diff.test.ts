// Tests for the pure Talabat catalog diff.
// Run: node --experimental-strip-types --test lib/talabat-diff.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { detectTalabatColumns, diffTalabat, baseSku, talabatEmailText, imageFileFor, type TalabatOurRow } from "./talabat-diff.ts";

const our = (over: Partial<TalabatOurRow>): TalabatOurRow => ({
  id: "p1", sku: "MK-1", barcode: null, name_en: "Rose Serum", name_ar: "سيروم الورد",
  approval: "Approved", hasVariants: false, price: 50, ...over,
});

test("detectTalabatColumns finds loose header names", () => {
  assert.deepEqual(
    detectTalabatColumns(["Item Code", "Barcode", "Product Name EN", "Product Name AR", "Price (QAR)"]),
    { sku: "Item Code", barcode: "Barcode", nameEn: "Product Name EN", nameAr: "Product Name AR", price: "Price (QAR)" },
  );
  assert.deepEqual(detectTalabatColumns(["SKU", "Title", "اسم المنتج"]), { sku: "SKU", nameEn: "Title", nameAr: "اسم المنتج" });
  assert.deepEqual(detectTalabatColumns(["Foo", "Bar"]), {});
});

test("baseSku strips our old variant-split suffix", () => {
  assert.equal(baseSku("MK123-4"), "mk123");
  assert.equal(baseSku("mk123"), "mk123");
});

test("diffTalabat: matched / missing / options marked for split / not-approved", () => {
  const d = diffTalabat(
    [
      our({}),                                                             // on Talabat by SKU
      our({ id: "p2", sku: "MK-2", name_en: "Gold Mask" }),                // missing (simple)
      our({ id: "p3", sku: "MK-3", name_en: "Nail Set", hasVariants: true }), // missing (will split)
      our({ id: "p4", sku: "MK-4", name_en: "Old Thing", approval: "Rejected" }), // not approved
      our({ id: "p5", sku: null, name_en: "Lip Tint" }),                   // on Talabat by name
    ],
    [
      { SKU: "mk-1", "Product Name EN": "whatever" },
      { SKU: "", "Product Name EN": "Lip  Tint" },
      { SKU: "ZZ-9", "Product Name EN": "Their Own Product" },
    ],
  );
  assert.equal(d.ok, true);
  assert.equal(d.counts.eligible, 4);
  assert.equal(d.counts.matched, 2);
  assert.deepEqual(d.missing, [
    { product_id: "p2", sku: "MK-2", name_en: "Gold Mask", hasVariants: false, image_url: null, noPrice: false },
    { product_id: "p3", sku: "MK-3", name_en: "Nail Set", hasVariants: true, image_url: null, noPrice: false },
  ]);
  assert.equal(d.counts.withOptions, 1);
  assert.equal(d.counts.notApproved, 1);
  assert.deepEqual(d.extraOnTalabat, [{ sku: "ZZ-9", name: "Their Own Product" }]);
});

test("diffTalabat: their variant-split SKU (mk123-2) still matches the parent", () => {
  const d = diffTalabat(
    [our({ sku: "MK123" })],
    [{ SKU: "MK123-2", "Product Name EN": "Rose Serum - Red" }],
  );
  assert.equal(d.counts.matched, 1);
  assert.equal(d.counts.extraOnTalabat, 0);
});

test("diffTalabat: unusable file yields a clear error", () => {
  assert.match(diffTalabat([our({})], []).error ?? "", /فاضي/);
  assert.match(diffTalabat([our({})], [{ Foo: 1 }]).error ?? "", /ما تعرّفت/);
});

test("diffTalabat flags missing products without a sellable price", () => {
  const d = diffTalabat(
    [
      our({ id: "p1", sku: "A", name_en: "Free Thing", price: 0 }),
      our({ id: "p2", sku: "B", name_en: "Disc Only", price: null, discount_price: 30 }),
    ],
    [{ SKU: "zz", "Product Name EN": "other" }],
  );
  assert.equal(d.counts.noPrice, 1);
  assert.equal(d.missing.find((m) => m.sku === "A")?.noPrice, true);
  assert.equal(d.missing.find((m) => m.sku === "B")?.noPrice, false);
});

test("talabatEmailText carries the count in both languages", () => {
  const t = talabatEmailText(46);
  assert.match(t, /46 منتج/);
  assert.match(t, /46 new products/);
});

test("imageFileFor: stored name wins, else derived from sku + url extension", () => {
  assert.equal(imageFileFor("mk1", "folder/mk1215.jpg", "ignored"), "mk1215.jpg");
  assert.equal(imageFileFor("MK2085", "", "https://cdn.shopify.com/s/files/x/mk2085.jpg?v=123"), "mk2085.jpg");
  assert.equal(imageFileFor("mk9", null, "https://cdn/img.WEBP"), "mk9.webp");
  assert.equal(imageFileFor("mk9", null, "https://cdn/no-extension"), "mk9.jpg");
  assert.equal(imageFileFor("", null, "https://cdn/img.jpg"), "");
  assert.equal(imageFileFor("mk9", null, ""), "");
});
