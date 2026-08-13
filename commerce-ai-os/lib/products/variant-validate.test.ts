// UX.4E-3 — the shared variant/product validation layer: exhaustive rule
// tests, the Create/Edit engine-parity proof, and source guards that keep the
// duplicated validation logic from coming back. PURE — no DB, no network, no
// React. Run:
//   node --conditions=react-server --experimental-strip-types --test lib/products/variant-validate.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  isBlankText,
  isBadNumber,
  isNegativeNumber,
  isNameMissing,
  isValidEan13,
  isValidMkSku,
  isValidVariantMkSku,
  MAIN_SKU_RE,
  VARIANT_SKU_RE,
  LOOSE_BARCODE_RE,
  firstDuplicateIndex,
  isTakenInCatalog,
  findCatalogDuplicates,
  isEmptyVariantRow,
  exceedsVariantLimit,
  validateProductFields,
  CREATE_PROFILE,
  EDIT_PROFILE,
  PRODUCT_NUMBER_FIELDS,
  VARIANT_NUMBER_FIELDS,
} from "./variant-validate.ts";
import { isMeaningfulVariant, EMPTY_VARIANT_FIELDS } from "./variant-model.ts";
import { validateAiProductInput } from "./create-validation.ts";
import { validateProductEditInput } from "./edit-validation.ts";
import type { ProductInput, VariantInput } from "./product-save.ts";

const GOOD_BARCODE = "4006381333931";
const GOOD_BARCODE_2 = "4006381333948";
const GOOD_BARCODE_3 = "9312345678907";

// ─────────────────────────── text / number rules ───────────────────────────

test("isBlankText: nullish and whitespace are blank; real text is not", () => {
  for (const v of ["", "   ", "\t\n", undefined as unknown as string, null as unknown as string]) {
    assert.equal(isBlankText(v), true, JSON.stringify(v));
  }
  assert.equal(isBlankText("x"), false);
  assert.equal(isBlankText("  a  "), false);
});

test("isBadNumber: blank is allowed; only unparseable non-blank is bad", () => {
  for (const ok of ["", "  ", "0", "12", "12.5", "-3", "1e3"]) assert.equal(isBadNumber(ok), false, ok);
  for (const bad of ["abc", "12,5", "1.2.3", "$5"]) assert.equal(isBadNumber(bad), true, bad);
});

test("isNegativeNumber: blank ok; negatives flagged; zero/positive ok", () => {
  for (const ok of ["", "0", "0.0", "5", "12.5"]) assert.equal(isNegativeNumber(ok), false, ok);
  for (const bad of ["-1", "-0.5"]) assert.equal(isNegativeNumber(bad), true, bad);
  assert.equal(isNegativeNumber("abc"), false, "non-numeric is not 'negative' (isBadNumber's job)");
});

test("isNameMissing: needs a name in at least one language", () => {
  assert.equal(isNameMissing("", ""), true);
  assert.equal(isNameMissing("  ", "\t"), true);
  assert.equal(isNameMissing("سيروم", ""), false);
  assert.equal(isNameMissing("", "Serum"), false);
});

// ─────────────────────── format rules (re-exported) ─────────────────────────

test("isValidEan13: verifies the check digit", () => {
  assert.ok(isValidEan13(GOOD_BARCODE));
  assert.ok(!isValidEan13("4006381333930")); // wrong check digit
  assert.ok(!isValidEan13("123"));
  assert.ok(!isValidEan13("40063813339311")); // 14 digits
});

test("isValidMkSku / isValidVariantMkSku: the mk grammar", () => {
  for (const ok of ["mk1", "mk999", "MK12"]) assert.ok(isValidMkSku(ok), ok);
  for (const bad of ["mk", "mk1a", "PRD1", ""]) assert.ok(!isValidMkSku(bad), bad);
  for (const ok of ["mk9-1", "mk9-12", "MK9-3"]) assert.ok(isValidVariantMkSku(ok, "mk9"), ok);
  for (const bad of ["mk9", "mk9-0", "mk9-01", "mk8-1", "mk9-A"]) assert.ok(!isValidVariantMkSku(bad, "mk9"), bad);
});

test("import-shape regexes stay loose and match core.ts's grammar", () => {
  assert.ok(MAIN_SKU_RE.test("mk123"));
  assert.ok(!MAIN_SKU_RE.test("MK123")); // core matches normalized (lowercased) text only
  assert.ok(VARIANT_SKU_RE.test("mk1-2"));
  assert.ok(!VARIANT_SKU_RE.test("mk1-0"));
  assert.ok(LOOSE_BARCODE_RE.test("123456")); // 6 digits ok (no check digit)
  assert.ok(LOOSE_BARCODE_RE.test("12345678901234")); // 14 digits ok
  assert.ok(!LOOSE_BARCODE_RE.test("12345")); // 5 too short
  assert.ok(!LOOSE_BARCODE_RE.test("123456789012345")); // 15 too long
});

// ───────────────────────── duplicate detection ─────────────────────────────

test("firstDuplicateIndex: returns the first repeat, else -1", () => {
  assert.equal(firstDuplicateIndex(["a", "b", "c"]), -1);
  assert.equal(firstDuplicateIndex(["a", "b", "a"]), 2);
  assert.equal(firstDuplicateIndex(["x", "x"]), 1);
  assert.equal(firstDuplicateIndex([]), -1);
});

test("isTakenInCatalog / findCatalogDuplicates: against-catalog rule", () => {
  const catalog = new Set(["mk1", "mk2", GOOD_BARCODE]);
  assert.ok(isTakenInCatalog("mk1", catalog));
  assert.ok(!isTakenInCatalog("mk9", catalog));
  assert.deepEqual(findCatalogDuplicates(["mk9", "mk2", "mk1", "mk8"], catalog), ["mk2", "mk1"]);
  assert.deepEqual(findCatalogDuplicates(["mk9"], catalog), []);
});

// ───────────────────────────── empty rows ──────────────────────────────────

test("isEmptyVariantRow: blank name+name_en+sku is empty; any one filled is not", () => {
  const base = { variant_name: "", variant_name_en: "", sku: "" };
  assert.ok(isEmptyVariantRow(base));
  assert.ok(isEmptyVariantRow({ ...base, variant_name: "  " }));
  assert.ok(!isEmptyVariantRow({ ...base, variant_name: "وردي" }));
  assert.ok(!isEmptyVariantRow({ ...base, variant_name_en: "Pink" }));
  assert.ok(!isEmptyVariantRow({ ...base, sku: "mk9-1" }));
});

test("guard: isEmptyVariantRow is the exact negation of variant-model's isMeaningfulVariant", () => {
  const cases = [
    { variant_name: "", variant_name_en: "", sku: "" },
    { variant_name: "وردي", variant_name_en: "", sku: "" },
    { variant_name: "", variant_name_en: "Pink", sku: "" },
    { variant_name: "", variant_name_en: "", sku: "mk9-1" },
    { variant_name: "  ", variant_name_en: "  ", sku: "  " },
  ];
  for (const c of cases) {
    const fields = { ...EMPTY_VARIANT_FIELDS, ...c };
    assert.equal(isEmptyVariantRow(c), !isMeaningfulVariant(fields), JSON.stringify(c));
  }
});

// ────────────────────────── variant count limit ────────────────────────────

test("exceedsVariantLimit: pure predicate, ceiling supplied by the caller", () => {
  assert.equal(exceedsVariantLimit(5, 10), false);
  assert.equal(exceedsVariantLimit(10, 10), false);
  assert.equal(exceedsVariantLimit(11, 10), true);
});

// ─────────────────────── the shared engine (profiles) ──────────────────────

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
    brand_id: "", main_category: "Korean Skincare", sub_category: "", product_type: "",
    color: "", size: "", price: "", discount_price: "", cost: "", stock_quantity: "",
    stock_status: "", platform_status: "", approval: "", rejection_reason: "",
    image_filename: "", image_url: "", description_en: "", description_ar: "",
    keywords_en: "", keywords_ar: "", notes: "", variants: [], ...over,
  };
}

test("engine: the number-field lists match Create's/Edit's historical sets", () => {
  assert.deepEqual([...PRODUCT_NUMBER_FIELDS], ["price", "discount_price", "cost", "stock_quantity"]);
  assert.deepEqual([...VARIANT_NUMBER_FIELDS], ["price", "stock_quantity"]);
});

test("engine (CREATE_PROFILE): full valid payload passes", () => {
  assert.ok(validateProductFields(input({ variants: [variant()] }), CREATE_PROFILE).ok);
});

test("engine (CREATE_PROFILE): requires a category; EDIT_PROFILE does not", () => {
  assert.deepEqual(validateProductFields(input({ main_category: "" }), CREATE_PROFILE), {
    ok: false, rule: "category_required", field: "main_category",
  });
  assert.ok(validateProductFields(input({ main_category: "" }), EDIT_PROFILE).ok);
});

test("engine (EDIT_PROFILE): row-id duplicate is caught; CREATE_PROFILE ignores ids", () => {
  const dupIds = input({ variants: [variant({ id: "va" }), variant({ id: "va", sku: "mk9-2", barcode: GOOD_BARCODE_3 })] });
  assert.deepEqual(validateProductFields(dupIds, EDIT_PROFILE), {
    ok: false, rule: "duplicate_variant_row", field: "variants",
  });
  // Create ignores ids, so with distinct sku/barcode this is valid under Create.
  assert.ok(validateProductFields(dupIds, CREATE_PROFILE).ok);
});

test("engine: every shape rule fires with the right field suffix", () => {
  assert.deepEqual(validateProductFields(input({ name_ar: "", name_en: "" }), CREATE_PROFILE),
    { ok: false, rule: "name_required", field: "name_ar" });
  assert.deepEqual(validateProductFields(input({ sku: "P-1" }), CREATE_PROFILE),
    { ok: false, rule: "invalid_sku", field: "sku" });
  assert.deepEqual(validateProductFields(input({ barcode: "123" }), CREATE_PROFILE),
    { ok: false, rule: "invalid_barcode", field: "barcode" });
  assert.deepEqual(validateProductFields(input({ price: "abc" }), CREATE_PROFILE),
    { ok: false, rule: "invalid_number", field: "price" });
  assert.deepEqual(validateProductFields(input({ cost: "-1" }), CREATE_PROFILE),
    { ok: false, rule: "negative_number", field: "cost" });
  assert.deepEqual(validateProductFields(input({ variants: [variant({ sku: "xyz" })] }), CREATE_PROFILE),
    { ok: false, rule: "invalid_variant_sku", field: "variant-0-sku" });
  assert.deepEqual(validateProductFields(input({ variants: [variant({ barcode: "111" })] }), CREATE_PROFILE),
    { ok: false, rule: "invalid_barcode", field: "variant-0-barcode" });
  assert.deepEqual(validateProductFields(input({ variants: [variant(), variant({ barcode: GOOD_BARCODE_3 })] }), CREATE_PROFILE),
    { ok: false, rule: "duplicate_in_form", field: "variant-1-sku" });
  assert.deepEqual(validateProductFields(input({ variants: [variant({ barcode: GOOD_BARCODE })] }), CREATE_PROFILE),
    { ok: false, rule: "duplicate_in_form", field: "variant-0-barcode" });
});

// ── regression: Create and Edit produce IDENTICAL engine results ────────────
// On inputs with a valid category and no duplicate row-ids — the only two flags
// that differ — the two profiles must agree rule-for-rule and field-for-field.

const PARITY_INPUTS: ProductInput[] = [
  input({ variants: [variant()] }),                                  // fully valid
  input({ name_ar: "", name_en: "" }),                               // name
  input({ sku: "P-1" }),                                             // main sku
  input({ barcode: "4006381333930" }),                               // main barcode
  input({ price: "abc" }),                                           // product number
  input({ stock_quantity: "-1" }),                                   // product negative
  input({ variants: [variant({ sku: "nope" })] }),                   // variant sku
  input({ variants: [variant({ barcode: "111" })] }),                // variant barcode
  input({ variants: [variant(), variant({ barcode: GOOD_BARCODE_3 })] }), // dup sku in form
  input({ variants: [variant({ barcode: GOOD_BARCODE })] }),         // variant reuses product barcode
  input({ variants: [variant({ price: "1,2" })] }),                  // variant number
];

test("regression: CREATE_PROFILE and EDIT_PROFILE agree on category-valid, id-clean inputs", () => {
  for (const p of PARITY_INPUTS) {
    assert.deepEqual(
      validateProductFields(p, CREATE_PROFILE),
      validateProductFields(p, EDIT_PROFILE),
      JSON.stringify({ sku: p.sku, barcode: p.barcode, variants: p.variants.length }),
    );
  }
});

test("regression: public Create/Edit validators agree on rule + field suffix", () => {
  for (const p of PARITY_INPUTS) {
    const c = validateAiProductInput(p);
    const e = validateProductEditInput(p);
    assert.equal(c.ok, e.ok, JSON.stringify(p.sku));
    if (!c.ok && !e.ok) {
      assert.equal(c.field.replace(/^create-/, ""), e.field.replace(/^edit-/, ""), "same field suffix");
    }
  }
});

// ── UX.4E-3 grandfathering: unchanged legacy identities pass in Edit ─────────
// A persisted (id-bearing) row keeps its legacy SKU/barcode when UNCHANGED; a
// changed value or a new row gets strict V2 validation. Create never grandfathers.

// An existing variant with a legacy identity + the persisted originals it loaded with.
function legacyVariant(over: Partial<VariantInput> = {}): VariantInput {
  return {
    ...variant({ id: "v1", sku: "LEG-ACY", barcode: "12345" }),
    original_sku: "LEG-ACY",
    original_barcode: "12345",
    ...over,
  };
}

test("grandfather: unchanged legacy variant SKU + edit price PASSES (Edit)", () => {
  const p = input({ variants: [legacyVariant({ price: "50" })] });
  assert.ok(validateProductFields(p, EDIT_PROFILE).ok);
});

test("grandfather: unchanged legacy variant barcode + edit name PASSES (Edit)", () => {
  const p = input({
    name_ar: "اسم جديد",
    variants: [legacyVariant({ variant_name: "لون جديد" })],
  });
  assert.ok(validateProductFields(p, EDIT_PROFILE).ok);
});

test("grandfather: unchanged legacy identity is grandfathered but STILL joins duplicate detection", () => {
  // Two grandfathered rows sharing a barcode: the collision is still caught.
  const dupBarcode = input({
    variants: [legacyVariant({ id: "v1" }), legacyVariant({ id: "v2", sku: "OTHER-9", original_sku: "OTHER-9" })],
  });
  assert.deepEqual(validateProductFields(dupBarcode, EDIT_PROFILE),
    { ok: false, rule: "duplicate_in_form", field: "variant-1-barcode" });
  // Two grandfathered rows sharing a SKU: also caught.
  const dupSku = input({
    variants: [legacyVariant({ id: "v1" }), legacyVariant({ id: "v2", barcode: "67890", original_barcode: "67890" })],
  });
  assert.deepEqual(validateProductFields(dupSku, EDIT_PROFILE),
    { ok: false, rule: "duplicate_in_form", field: "variant-1-sku" });
});

test("grandfather: CHANGED legacy variant SKU → strict V2 rule (invalid new SKU FAILS)", () => {
  const p = input({ variants: [legacyVariant({ sku: "still-bad" })] }); // sku changed, not mk-n
  assert.deepEqual(validateProductFields(p, EDIT_PROFILE),
    { ok: false, rule: "invalid_variant_sku", field: "variant-0-sku" });
});

test("grandfather: CHANGED legacy variant barcode → strict EAN (invalid new barcode FAILS)", () => {
  const p = input({ variants: [legacyVariant({ sku: "mk9-1", barcode: "999" })] }); // barcode changed
  assert.deepEqual(validateProductFields(p, EDIT_PROFILE),
    { ok: false, rule: "invalid_barcode", field: "variant-0-barcode" });
});

test("grandfather: CHANGED identity to valid V2 values PASSES", () => {
  const p = input({ variants: [legacyVariant({ sku: "mk9-1", barcode: GOOD_BARCODE_2 })] });
  assert.ok(validateProductFields(p, EDIT_PROFILE).ok);
});

test("grandfather: NEW variant (no id) always gets strict V2 validation", () => {
  assert.deepEqual(validateProductFields(input({ variants: [variant({ sku: "xyz" })] }), EDIT_PROFILE),
    { ok: false, rule: "invalid_variant_sku", field: "variant-0-sku" });
  assert.deepEqual(validateProductFields(input({ variants: [variant({ sku: "mk9-1", barcode: "111" })] }), EDIT_PROFILE),
    { ok: false, rule: "invalid_barcode", field: "variant-0-barcode" });
});

test("grandfather: unchanged legacy MAIN identity is grandfathered in Edit", () => {
  const p = input({ sku: "OLD-MAIN", barcode: "42", original_sku: "OLD-MAIN", original_barcode: "42", price: "9" });
  assert.ok(validateProductFields(p, EDIT_PROFILE).ok);
  // Changing the legacy main SKU to a still-invalid value fails strictly.
  const changed = input({ sku: "OLD-MAIN-X", barcode: "42", original_sku: "OLD-MAIN", original_barcode: "42" });
  assert.deepEqual(validateProductFields(changed, EDIT_PROFILE), { ok: false, rule: "invalid_sku", field: "sku" });
});

test("grandfather: Create NEVER grandfathers — legacy identity + originals still fails", () => {
  const p = input({ variants: [legacyVariant()] });
  assert.deepEqual(validateProductFields(p, CREATE_PROFILE),
    { ok: false, rule: "invalid_variant_sku", field: "variant-0-sku" });
  // The public creator validator is likewise unaffected by original_* fields.
  const c = validateAiProductInput(p);
  assert.ok(!c.ok);
});

test("grandfather: the public Edit validator grandfathers via payload originals", () => {
  assert.ok(validateProductEditInput(input({ variants: [legacyVariant({ price: "5" })] })).ok);
  const changed = validateProductEditInput(input({ variants: [legacyVariant({ barcode: "999" })] }));
  assert.ok(!changed.ok && changed.field === "edit-variant-0-barcode");
});

// ── source guards: the duplicated validation logic must not come back ────────

function read(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), "utf8");
}

test("guard: create-validation + edit-validation delegate to the shared engine", () => {
  for (const name of ["create-validation.ts", "edit-validation.ts"]) {
    const code = read(`./${name}`);
    assert.ok(code.includes('from "./variant-validate.ts"'), `${name} imports the shared layer`);
    assert.ok(code.includes("validateProductFields("), `${name} calls the shared engine`);
  }
});

test("guard: neither validator re-inlines the EAN math, mk regex, or duplicate sets", () => {
  const forbidden = [
    "/^\\d{13}$/",   // inlined EAN-13 shape
    "seenSkus",      // inlined within-form dup set
    "seenBarcodes",
    "seenIds",       // inlined row-id dup set (edit)
    "variantSkuRe",  // inlined variant-sku regex (create)
    "MK_RE",         // inlined main-sku regex (create)
  ];
  for (const name of ["create-validation.ts", "edit-validation.ts"]) {
    const code = read(`./${name}`);
    for (const token of forbidden) {
      assert.equal(code.includes(token), false, `${name} must not inline ${token}`);
    }
  }
});

test("UX.4E-8A source guard: Import's core.ts imports the shared grammar, no local copies", () => {
  const core = read("./excel-import/core.ts");
  // The canonical source strings still live here, in variant-validate.
  assert.equal(MAIN_SKU_RE.source, "^mk[0-9]+$");
  assert.equal(VARIANT_SKU_RE.source, "^mk[0-9]+-[1-9][0-9]*$");
  assert.equal(LOOSE_BARCODE_RE.source, "^\\d{6,14}$");
  // core.ts now IMPORTS them from variant-validate…
  assert.ok(
    /import\s*\{[^}]*\bMAIN_SKU_RE\b[^}]*\}\s*from\s*"\.\.\/variant-validate\.ts"/.test(core),
    "core.ts imports the shared grammar from variant-validate",
  );
  assert.ok(core.includes("VARIANT_SKU_RE") && core.includes("isLooseBarcode"),
    "core.ts references the shared VARIANT_SKU_RE + loose-barcode helper");
  // …and declares NO local copies (neither const nor inline regex literal).
  assert.equal(/const\s+MAIN_SKU_RE\s*=/.test(core), false, "no local MAIN_SKU_RE declaration");
  assert.equal(/const\s+VARIANT_SKU_RE\s*=/.test(core), false, "no local VARIANT_SKU_RE declaration");
  assert.equal(/const\s+LOOSE_BARCODE_RE\s*=/.test(core), false, "no local LOOSE_BARCODE_RE declaration");
  assert.equal(core.includes("/^mk[0-9]+$/"), false, "no inline main-sku regex literal");
  assert.equal(core.includes("/^mk[0-9]+-[1-9][0-9]*$/"), false, "no inline variant-sku regex literal");
  assert.equal(core.includes("/^\\d{6,14}$/"), false, "no inline loose-barcode regex literal");
});
