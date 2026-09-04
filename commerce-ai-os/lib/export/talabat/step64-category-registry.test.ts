// STEP 64 — the Talabat category registry + resolver.
//
// Owner decisions pinned here:
//   1. canonical "Toys"                → "✨Toys"  (U+2728, no separating space)
//   2. "🌙 Eid Specials" is TEMPORARY/CAMPAIGN — never a permanent mapping
//   3. canonical "Women’s Essentials"  → "Women’s Essentials" (U+2019, never ASCII)
//
// The resolver is INPUT-TOLERANT and OUTPUT-EXACT, and FAILS CLOSED: unknown
// free text is never passed through to the marketplace.
//
// node --conditions=react-server --experimental-strip-types --test lib/export/talabat/step64-category-registry.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  TALABAT_NATIVE_CATEGORIES,
  TALABAT_CAMPAIGN_CATEGORIES,
  TALABAT_OUTPUT_CATEGORIES,
  resolveTalabatCategory,
  talabatCategoryByCanonicalName,
} from "./native-template.ts";
import { buildTalabatPreview, type TalabatPreviewProduct } from "./preview.ts";
import { toPackageRow, buildTalabatXlsxAoa } from "./package.ts";

const HERE = join(fileURLToPath(new URL(".", import.meta.url)));
const APP_ROOT = join(HERE, "../../..");
const code = (rel: string): string =>
  readFileSync(join(APP_ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

/** The exact code points the owner specified — spelled out, never pasted blind. */
const SPARKLES = "✨";          // ✨
const RSQUO = "’";             // ’
const TOYS_OUT = `${SPARKLES}Toys`;
const WOMENS_OUT = `Women${RSQUO}s Essentials`;

/** The 16 canonical master categories (production distribution, STEP 63). */
const CANONICAL_16 = [
  "Face Care", "Lashes & Nails", "Beauty Accessories", "Hair Care", "Makeup",
  "Body Care", WOMENS_OUT, "Rhode Products Section", "Electronics", "Masks",
  "Dental Care", "Thailand Products", "Summer And Camping Supplies",
  "Beauty Bundle", "Toys", "Sun Protection",
] as const;

function product(over: Partial<TalabatPreviewProduct> & { id: string; sku: string }): TalabatPreviewProduct {
  return {
    barcode: "1234567890123", nameEn: `EN ${over.sku}`, nameAr: `ع ${over.sku}`,
    price: 50, discountPrice: null, category: "Face Care", descriptionEn: "d", descriptionAr: "و",
    imageUrl: `https://example.test/${over.sku}.jpg`, imageFilename: `${over.sku}.jpg`,
    galleryImageUrls: [], imageCount: 1, approved: true, lifecycleState: "ACTIVE",
    variants: [], ...over,
  };
}

// ── 1 & 2: Toys → ✨Toys, from either input form ──────────────────────────────

test("1: canonical 'Toys' resolves to the exact emoji-prefixed Talabat value", () => {
  const r = resolveTalabatCategory("Toys");
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.category, TOYS_OUT);
  // byte-exact: U+2728 immediately followed by "Toys", no space
  const out = talabatCategoryByCanonicalName("Toys")!;
  assert.equal(out.codePointAt(0), 0x2728, "starts with U+2728 SPARKLES");
  assert.equal(out.slice(1), "Toys", "no separating space");
  assert.equal(out.length, 5);
});

test("2: the decorated input '✨Toys' also resolves to '✨Toys'", () => {
  for (const input of [TOYS_OUT, `${SPARKLES} Toys`, " Toys ", "Toys"]) {
    const r = resolveTalabatCategory(input);
    assert.equal(r.ok, true, `${JSON.stringify(input)} must resolve`);
    assert.equal(r.ok && r.category, TOYS_OUT);
  }
});

// ── 3 & 4: Women’s Essentials always emits U+2019 ────────────────────────────

test("3: ASCII-apostrophe input emits the U+2019 Talabat value", () => {
  const r = resolveTalabatCategory("Women's Essentials");
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.category, WOMENS_OUT);
  assert.equal(talabatCategoryByCanonicalName("Women's Essentials")!.includes(RSQUO), true);
  assert.equal(talabatCategoryByCanonicalName("Women's Essentials")!.includes("'"), false,
    "the ASCII apostrophe must never be emitted");
});

test("4: U+2019 input emits the same U+2019 value, unchanged", () => {
  const r = resolveTalabatCategory(WOMENS_OUT);
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.category, WOMENS_OUT);
  assert.equal(r.ok && r.category.codePointAt(5), 0x2019);
});

// ── 5: exact pass-through of a plain category ────────────────────────────────

test("5: 'Summer And Camping Supplies' passes through byte-exact", () => {
  const r = resolveTalabatCategory("Summer And Camping Supplies");
  assert.equal(r.ok && r.category, "Summer And Camping Supplies");
  // it is NOT renamed to Rafeeq's "Summer Essentials" — no Rafeeq assumption leaks
  assert.notEqual(r.ok && r.category, "Summer Essentials");
  assert.equal(code("lib/export/talabat/native-template.ts").includes("Summer Essentials"), false);
});

// ── 6: the campaign category is not a permanent mapping ──────────────────────

test("6: '🌙 Eid Specials' is NOT in the registry and never resolves", () => {
  assert.equal(Object.prototype.hasOwnProperty.call(TALABAT_NATIVE_CATEGORIES, "Eid Specials"), false);
  assert.equal(TALABAT_OUTPUT_CATEGORIES.some((c) => c.includes("Eid")), false);
  for (const input of ["🌙 Eid Specials", "Eid Specials", "eid specials"]) {
    const r = resolveTalabatCategory(input);
    assert.equal(r.ok, false, `${input} must not resolve`);
    assert.equal(r.ok === false && r.reason, "unknown");
  }
  // it is retained as documented evidence, so the omission is provably deliberate
  assert.deepEqual([...TALABAT_CAMPAIGN_CATEGORIES], ["🌙 Eid Specials"]);
});

// ── 7: fail closed ───────────────────────────────────────────────────────────

test("7: an unknown or empty category FAILS CLOSED — never passed through", () => {
  for (const bad of ["Korean Skincare", "Skincare", "Perfumes", "Watches", "random free text", "FACE CARE"]) {
    const r = resolveTalabatCategory(bad);
    assert.equal(r.ok, false, `${bad} must not resolve`);
    assert.equal(r.ok === false && r.reason, "unknown");
    assert.equal(talabatCategoryByCanonicalName(bad), undefined);
  }
  for (const empty of [null, undefined, "", "   "]) {
    const r = resolveTalabatCategory(empty);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, "missing");
  }
});

// ── 8: every canonical master category resolves ──────────────────────────────

test("8: all 16 canonical master categories resolve to distinct exact values", () => {
  assert.equal(Object.keys(TALABAT_NATIVE_CATEGORIES).length, 16);
  const outs = new Set<string>();
  for (const c of CANONICAL_16) {
    const r = resolveTalabatCategory(c);
    assert.equal(r.ok, true, `${c} must resolve`);
    outs.add((r as { category: string }).category);
  }
  assert.equal(outs.size, 16, "16 distinct Talabat output categories");
  assert.deepEqual([...outs].sort(), [...TALABAT_OUTPUT_CATEGORIES].sort());
  // exactly one output is decorated
  assert.deepEqual(TALABAT_OUTPUT_CATEGORIES.filter((c) => /[☀-➿\u{1F000}-\u{1FAFF}]/u.test(c)), [TOYS_OUT]);
});

// ── 9: the whole master flattens with a resolved category ────────────────────

test("9: every master row carries a resolved Talabat category; none blocked on it", () => {
  const products = CANONICAL_16.map((c, i) =>
    product({ id: `p${i}`, sku: `mk${1000 + i}`, barcode: `111111111${String(i).padStart(4, "0")}`, category: c }));
  const res = buildTalabatPreview({ products });
  assert.equal(res.rows.length, 16);
  assert.equal(res.rows.every((r) => r.talabatCategory !== null), true);
  assert.equal(res.rows.some((r) => r.reasons.some((x) => x.code === "MISSING_CATEGORY")), false);
  assert.equal(res.summary.blocked, 0);
  // the Toys row ships the emoji form even though canonical says plain "Toys"
  const toys = res.rows.find((r) => r.category === "Toys")!;
  assert.equal(toys.talabatCategory, TOYS_OUT);
  // and the sheet carries the SAME exact strings (Category is column index 6)
  const aoa = buildTalabatXlsxAoa(res.rows.map((r) => toPackageRow(r, `${r.sku}.jpg`)));
  const catCol = aoa.slice(1).map((row) => row[6]);
  assert.equal(catCol.includes(TOYS_OUT), true, "the sheet carries ✨Toys");
  assert.equal(catCol.includes(WOMENS_OUT), true, "the sheet carries the U+2019 form");
  assert.equal(catCol.some((c) => String(c).includes("Eid")), false);
});

// ── 10: no raw category pass-through survives in any export path ─────────────

test("10: no certified Talabat export path emits a raw canonical category", () => {
  const pkg = code("lib/export/talabat/package.ts");
  assert.equal(/category:\s*r\.category\s*\?\?/.test(pkg), false, "the old raw pass-through is gone");
  assert.match(pkg, /category:\s*r\.talabatCategory\s*\?\?/);

  const pv = code("lib/export/talabat/preview.ts");
  assert.match(pv, /resolveTalabatCategory\(/);
  assert.match(pv, /talabatCategory/);

  const ex = code("lib/talabat/export.ts");
  assert.match(ex, /resolveTalabatCategory\(p\.main_category\)/);
  assert.equal(/const category = clean\(p\.main_category\)/.test(ex), false);

  // the legacy .mjs sheet builder must consume the resolved field only
  const mjs = code("lib/malak/talabat-export.mjs");
  assert.match(mjs, /Category:\s*clean\(p\.talabat_category\)/);
  assert.equal(/Category:\s*clean\(p\.main_category\)/.test(mjs), false);

  // …and its caller resolves before building, dropping unresolved products
  const actions = code("app/(app)/import-export/talabat-actions.ts");
  assert.match(actions, /resolveTalabatCategory\(p\.main_category\)/);
  assert.match(actions, /p\.talabat_category = r\.category/);
});

// ── the registry invents nothing ─────────────────────────────────────────────

test("11: the registry carries no fabricated Talabat ids and no Rafeeq leakage", () => {
  const src = code("lib/export/talabat/native-template.ts");
  assert.equal(/\bid:\s*\d/.test(src), false, "no numeric Talabat category id is invented");
  assert.equal(/RAFEEQ/i.test(src), false, "no Rafeeq registry is imported or referenced");
  // every registry value is a plain string pair
  for (const [k, v] of Object.entries(TALABAT_NATIVE_CATEGORIES)) {
    assert.equal(typeof v.talabat, "string");
    assert.ok(v.talabat.length > 0, `${k} has a non-empty output`);
    assert.equal(typeof v.evidenceRows, "number");
    assert.ok(v.evidenceRows > 0, `${k} is backed by historical evidence`);
  }
  // total evidence equals the historical file's non-campaign rows (1146 - 19)
  const total = Object.values(TALABAT_NATIVE_CATEGORIES).reduce((a, c) => a + c.evidenceRows, 0);
  assert.equal(total, 1146 - 19, "evidence sums to the file minus the campaign rows");
});
