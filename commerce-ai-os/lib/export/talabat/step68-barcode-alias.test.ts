// STEP 68 — the Talabat EXPORT-LOCAL variant barcode alias.
//
// Owner decision: canonical product_variants.barcode is NEVER modified — STEP 67
// proved the 159 hyphenated values are live Shopify identity (159 active
// shopify:malikas ECL rows, 154 Shopify snapshots, 59 staff tasks). The
// transformation is confined to the Talabat output layer:
//
//   ^\d{13}-\d$   ->  hyphen removed, 14 numeric digits
//   plain numeric ->  preserved byte-for-byte
//   anything else ->  FAIL CLOSED
//
// The 14-digit result is a TALABAT EXPORT-LOCAL INTERNAL NUMERIC ALIAS — not a
// GTIN, not GS1, not EAN-14, not a manufacturer barcode.
//
// node --conditions=react-server --experimental-strip-types --test lib/export/talabat/step68-barcode-alias.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  resolveTalabatBarcode,
  reverseTalabatBarcodeAlias,
  isTalabatAliasSource,
  TALABAT_ALIAS_SOURCE_RE,
} from "./barcode-alias.ts";
import { buildTalabatPreview, type TalabatPreviewProduct } from "./preview.ts";
import { toPackageRow, buildTalabatXlsxAoa } from "./package.ts";

const HERE = join(fileURLToPath(new URL(".", import.meta.url)));
const APP_ROOT = join(HERE, "../../..");
const code = (rel: string): string =>
  readFileSync(join(APP_ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

/** The 3 genuine manufacturer variant barcodes on mk1195 (production). */
const GENUINE = ["850055526181", "850055527232", "850055527171"] as const;

/** Reproduce the production shape: 51 parents, 159 suffixed variant barcodes. */
function productionTargets(): { parent: string; variant: string }[] {
  const out: { parent: string; variant: string }[] = [];
  const n = 1_000_000_000_000;
  for (let p = 0; p < 51; p++) {
    const parent = String(n + p * 7);              // distinct 13-digit parents
    const options = p < 45 ? 3 : 4;                // 45*3 + 6*4 = 159
    for (let i = 1; i <= options; i++) out.push({ parent, variant: `${parent}-${i}` });
  }
  return out.slice(0, 159);
}

function product(over: Partial<TalabatPreviewProduct> & { id: string; sku: string }): TalabatPreviewProduct {
  return {
    barcode: "1234567890123", nameEn: `EN ${over.sku}`, nameAr: `ع ${over.sku}`,
    price: 50, discountPrice: null, category: "Face Care", descriptionEn: "d", descriptionAr: "و",
    imageUrl: `https://example.test/${over.sku}.jpg`, imageFilename: `${over.sku}.jpg`,
    galleryImageUrls: [], imageCount: 1, approved: true, lifecycleState: "ACTIVE",
    variants: [], ...over,
  };
}

// ── 1–4: the transformation itself ───────────────────────────────────────────

test("1: 13-digit parent + '-1' becomes exactly 14 numeric digits", () => {
  const r = resolveTalabatBarcode("8719783947424-1");
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.barcode, "87197839474241");
  assert.equal(r.ok && r.kind, "alias");
  assert.match((r as { barcode: string }).barcode, /^\d{14}$/);
});

test("2: the canonical source value is never mutated", () => {
  const canonical = "8719783947424-1";
  const before = canonical;
  const r = resolveTalabatBarcode(canonical);
  assert.equal(canonical, before, "the input string is untouched");
  assert.notEqual(r.ok && r.barcode, canonical, "the alias is a NEW value, not a rewrite");
  // and the module never writes anywhere
  const src = code("lib/export/talabat/barcode-alias.ts");
  for (const w of ["update", "insert", "upsert", "delete", "from(", "supabase", "fetch("]) {
    assert.equal(src.includes(w), false, `the resolver must not reference ${w}`);
  }
});

test("3: the transformation is deterministic", () => {
  for (let i = 0; i < 50; i++) {
    assert.equal((resolveTalabatBarcode("8719783947424-1") as { barcode: string }).barcode, "87197839474241");
  }
  // stable across independent inputs too
  const a = productionTargets().map((t) => (resolveTalabatBarcode(t.variant) as { barcode: string }).barcode);
  const b = productionTargets().map((t) => (resolveTalabatBarcode(t.variant) as { barcode: string }).barcode);
  assert.deepEqual(a, b, "regeneration yields byte-identical output");
});

test("4: the transformation is reversible", () => {
  assert.equal(reverseTalabatBarcodeAlias("87197839474241"), "8719783947424-1");
  assert.equal(reverseTalabatBarcodeAlias("1234567890123"), undefined, "13 digits is not an alias");
  assert.equal(reverseTalabatBarcodeAlias("abc"), undefined);
});

// ── 5: genuine barcodes untouched ────────────────────────────────────────────

test("5: the 3 genuine 12-digit UPCs are preserved byte-for-byte", () => {
  for (const g of GENUINE) {
    const r = resolveTalabatBarcode(g);
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.barcode, g, `${g} must pass through unchanged`);
    assert.equal(r.ok && r.kind, "genuine");
  }
});

// ── 6–8: the full production target set ──────────────────────────────────────

test("6: all 159 current targets resolve to aliases", () => {
  const targets = productionTargets();
  assert.equal(targets.length, 159);
  const resolved = targets.map((t) => resolveTalabatBarcode(t.variant));
  assert.equal(resolved.every((r) => r.ok), true, "every target resolves");
  assert.equal(resolved.every((r) => r.ok && r.kind === "alias"), true);
  assert.equal(resolved.every((r) => r.ok && /^\d{14}$/.test(r.barcode)), true, "all 14 numeric digits");
});

test("7: the 159 aliases are unique", () => {
  const targets = productionTargets();
  assert.equal(new Set(targets.map((t) => t.variant)).size, 159, "sources are unique");
  const aliases = targets.map((t) => (resolveTalabatBarcode(t.variant) as { barcode: string }).barcode);
  assert.equal(new Set(aliases).size, 159, "aliases are unique");
});

test("8: zero collisions across the whole Talabat barcode universe", () => {
  const targets = productionTargets();
  const aliases = targets.map((t) => (resolveTalabatBarcode(t.variant) as { barcode: string }).barcode);
  const parents = [...new Set(targets.map((t) => t.parent))];          // simple/parent barcodes
  const universe = [...aliases, ...parents, ...GENUINE];
  assert.equal(new Set(universe).size, universe.length, "no duplicate anywhere in the dataset");
  // an alias can never equal a 13-digit parent or a 12-digit genuine value: length differs
  assert.equal(aliases.every((a) => a.length === 14), true);
  assert.equal(parents.every((p) => p.length === 13), true);
  assert.equal(GENUINE.every((g) => g.length === 12), true);
});

// ── 9: end-to-end, no hyphen reaches the sheet ───────────────────────────────

test("9: zero hyphenated rows in the generated Talabat sheet", () => {
  const parent = "8719783947424";
  const res = buildTalabatPreview({
    products: [
      product({ id: "simple", sku: "mkS", barcode: "1234567890123" }),
      product({
        id: "opt", sku: "mk1879", barcode: parent,
        variants: [1, 2, 3].map((i) => ({
          id: `v${i}`, sku: `mk1879-${i}`, barcode: `${parent}-${i}`,
          nameEn: null, nameAr: `لون ${i}`, price: 56,
        })),
      }),
      product({ id: "gen", sku: "mk1195", barcode: "5652355927892",
        variants: [{ id: "g1", sku: "mk1195-8", barcode: GENUINE[0], nameEn: null, nameAr: "وردي", price: 60 }] }),
    ],
  });
  assert.equal(res.summary.blocked, 0, "nothing blocked");
  const aoa = buildTalabatXlsxAoa(res.rows.map((r) => toPackageRow(r, `${r.sku}.jpg`)));
  const barcodeCol = aoa.slice(1).map((row) => String(row[1]));
  assert.equal(barcodeCol.some((b) => b.includes("-")), false, "no hyphen reaches the sheet");
  assert.equal(barcodeCol.every((b) => /^\d+$/.test(b)), true, "every emitted barcode is numeric");
  assert.ok(barcodeCol.includes("87197839474241"), "the alias is emitted");
  assert.ok(barcodeCol.includes(GENUINE[0]), "the genuine UPC is emitted unchanged");
  assert.equal(new Set(barcodeCol).size, barcodeCol.length, "no duplicates in the sheet");
  // the CANONICAL value is still carried on the row for diagnostics
  const optRow = res.rows.find((r) => r.sku === "mk1879-1")!;
  assert.equal(optRow.barcode, `${parent}-1`, "canonical value preserved on the row");
  assert.equal(optRow.talabatBarcode, "87197839474241", "export value is the alias");
});

// ── 10–11: fail closed ───────────────────────────────────────────────────────

test("10: an unknown non-numeric variant format FAILS CLOSED", () => {
  for (const bad of ["VARIANT-BC", "abc", "12-34-56", "8719783947424-A", "SKU-1", "  ", ""]) {
    const r = resolveTalabatBarcode(bad);
    assert.equal(r.ok, false, `${JSON.stringify(bad)} must not resolve`);
  }
  assert.equal((resolveTalabatBarcode(null) as { reason: string }).reason, "missing");
  assert.equal((resolveTalabatBarcode("abc") as { reason: string }).reason, "unsupported");
  // and the preview BLOCKS such a row rather than passing it through
  const res = buildTalabatPreview({ products: [product({ id: "x", sku: "X1", barcode: "NOT-A-BARCODE" })] });
  assert.equal(res.rows[0]!.status, "BLOCKED");
  assert.equal(res.rows[0]!.talabatBarcode, null);
});

test("11: a two-digit suffix ('-10') does NOT use this transformation", () => {
  const r = resolveTalabatBarcode("1234567890123-10");
  assert.equal(r.ok, false, "removing its hyphen would yield 15 digits — unaudited");
  assert.equal(r.ok === false && r.reason, "unsupported");
  assert.equal(isTalabatAliasSource("1234567890123-10"), false);
  assert.equal(isTalabatAliasSource("1234567890123-1"), true);
  assert.equal(TALABAT_ALIAS_SOURCE_RE.source, String.raw`^\d{13}-\d$`);
});

// ── 12: parents unchanged ────────────────────────────────────────────────────

test("12: simple/parent barcodes pass through unchanged", () => {
  for (const p of ["1234567890123", "0429766714844", "9921936948112"]) {
    const r = resolveTalabatBarcode(p);
    assert.equal(r.ok && r.barcode, p, "byte-for-byte");
    assert.equal(r.ok && r.kind, "genuine");
  }
  // leading zero survives (it is a string, never a number)
  assert.equal((resolveTalabatBarcode("0429766714844") as { barcode: string }).barcode.startsWith("0"), true);
});

// ── 13–15: other channels untouched ──────────────────────────────────────────

test("13: Shopify code does not import or use the Talabat alias", () => {
  for (const rel of ["lib/shopify/admin.ts", "app/(app)/import-export/shopify-adapter.server.ts"]) {
    const s = code(rel);
    assert.equal(/barcode-alias/.test(s), false, `${rel} must not import the Talabat alias`);
    assert.equal(/resolveTalabatBarcode/.test(s), false);
  }
});

test("14: Rafeeq behaviour is untouched", () => {
  const s = code("lib/export/rafeeq/preview.ts");
  assert.equal(/barcode-alias|resolveTalabatBarcode/.test(s), false, "no Talabat alias in Rafeeq");
  assert.match(s, /const barcode = sku \|\| null;/, "Rafeeq still emits the SKU in its barcode column");
});

test("15: Snoonu and Pure Seoul are untouched", () => {
  for (const rel of ["lib/adapters/snoonu/barcode/barcode-completion.server.ts",
                     "app/(app)/import-export/pure-seoul-actions.ts"]) {
    const s = code(rel);
    assert.equal(/barcode-alias|resolveTalabatBarcode/.test(s), false, `${rel} must not use the Talabat alias`);
  }
});

test("16: the alias is never described as a GTIN / GS1 / EAN-14", () => {
  const src = readFileSync(join(APP_ROOT, "lib/export/talabat/barcode-alias.ts"), "utf8");
  // the words appear ONLY in the disclaimer that denies them
  for (const term of ["GTIN", "GS1", "EAN-14"]) {
    const idx = src.indexOf(term);
    assert.ok(idx > 0, `${term} is mentioned`);
    assert.ok(/NOT a GTIN, NOT a GS1 barcode, NOT an EAN-14/.test(src), "explicitly disclaimed");
  }
  // no EAN generator is used here
  assert.equal(/generateUniqueEan13Batch|ean13/i.test(code("lib/export/talabat/barcode-alias.ts")), false);
});
