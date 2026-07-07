// Tests for the standalone-title logic of the Talabat option splitter.
// Run: node --experimental-strip-types --test lib/talabat-split-name.test.ts

import test from "node:test";
import assert from "node:assert/strict";

// @ts-expect-error — plain-JS module (single Talabat format source of truth)
import { cleanSplitName, buildTalabatRows } from "./malak/talabat-export.mjs";

test("cleanSplitName: enumerating parent keeps only this option", () => {
  const parent = "Gege Bear Lip Gloss – Night Soaked Wisteria 07# & Model 02# Lip Gloss";
  const sibs = ["Night Soaked Wisteria 07#", "Model 02# Lip Gloss"];
  assert.equal(cleanSplitName(parent, sibs[0], sibs), "Gege Bear Lip Gloss – Night Soaked Wisteria 07#");
  assert.equal(cleanSplitName(parent, sibs[1], sibs), "Gege Bear Lip Gloss – Model 02# Lip Gloss");
});

test("cleanSplitName: middle option removal leaves no dangling separators", () => {
  const parent = "Set – A & B & C";
  const sibs = ["A", "B", "C"];
  assert.equal(cleanSplitName(parent, "B", sibs), "Set – B");
});

test("cleanSplitName: plain parent gets the option appended once", () => {
  assert.equal(cleanSplitName("Nail Set", "Red", ["Red", "Pink"]), "Nail Set - Red");
  assert.equal(cleanSplitName("Nail Set", "", ["Red"]), "Nail Set");
});

test("buildTalabatRows: split rows carry the clean standalone titles", () => {
  const { rows } = buildTalabatRows(
    [{
      id: "p1", sku: "mk1689", barcode: "", price: 49, discount_price: null,
      name_en: "Gege Bear Lip Gloss – Night Soaked Wisteria 07# & Model 02# Lip Gloss",
      name_ar: "قلوس جيجي بير", main_category: "Makeup",
      description_en: "x", description_ar: "", image_filename: "mk1689.jpg",
    }],
    [
      { parent_product_id: "p1", variant_name: "Night Soaked Wisteria 07#", sku: "mk1689-1" },
      { parent_product_id: "p1", variant_name: "Model 02# Lip Gloss", sku: "mk1689-2" },
    ],
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0]["SKU"], "mk1689-1");
  assert.equal(rows[0]["Product Name EN"], "Gege Bear Lip Gloss – Night Soaked Wisteria 07#");
  assert.equal(rows[1]["Product Name EN"], "Gege Bear Lip Gloss – Model 02# Lip Gloss");
  // Arabic parent doesn't contain the (English) option → plain suffix form.
  assert.equal(rows[0]["Product Name AR"], "قلوس جيجي بير - Night Soaked Wisteria 07#");
});
