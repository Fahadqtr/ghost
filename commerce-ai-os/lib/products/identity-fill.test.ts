// UX.4B — Identity fill helpers tests.
// PURE tests only — no database, no network, no rendering.
//
// Run: node --conditions=react-server --experimental-strip-types --test lib/products/identity-fill.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  copyProductPriceToEmpty,
  fillMissingVariantBarcodes,
  fillMissingVariantSkus,
  generateAllMissingIdentity,
  nextMainBarcode,
  nextMainSku,
} from "./identity-fill.ts";
import { isValidEan13 } from "./barcode-ean13.ts";
import { isValidMkSku } from "./sku-generate.ts";

/** Deterministic [0,1) source so barcode tests are reproducible. */
function seeded(seed = 1): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

// ── main SKU / barcode ───────────────────────────────────────────────────────

test("main SKU generation = next mk number over products + variants", () => {
  assert.equal(nextMainSku(["mk3", "mk10", "mk10-2"]), "mk11");
  assert.ok(isValidMkSku(nextMainSku([])));
});

test("main barcode generation = a valid EAN-13 not already in use", () => {
  const existing = new Set<string>(["0000000000000"]);
  const code = nextMainBarcode(existing, seeded(7));
  assert.ok(isValidEan13(code), "valid EAN-13");
  assert.equal(existing.has(code), false, "not a collision");
});

// ── fill-missing only (no overwrite) ─────────────────────────────────────────

test("variant SKU generation fills ONLY empty rows, by position; existing untouched", () => {
  const rows = [{ sku: "" }, { sku: "custom" }, { sku: "" }];
  const out = fillMissingVariantSkus("mk50", rows);
  assert.deepEqual(out, ["mk50-1", "custom", "mk50-3"]);
});

test("variant barcode generation fills ONLY empty rows and avoids collisions", () => {
  const existing = new Set<string>();
  const rows = [{ barcode: "" }, { barcode: "1234567890128" }, { barcode: "" }];
  const out = fillMissingVariantBarcodes(rows, existing, seeded(3), ["9999999999999"]);
  assert.equal(out[1], "1234567890128", "existing barcode untouched");
  assert.ok(isValidEan13(out[0]) && isValidEan13(out[2]), "generated are valid EAN-13");
  assert.notEqual(out[0], out[2], "generated barcodes are distinct");
  for (const c of [out[0], out[2]]) {
    assert.notEqual(c, "1234567890128", "never reuses a row barcode");
    assert.notEqual(c, "9999999999999", "never reuses an extraTaken barcode");
  }
});

test("collision helper is reused — generated codes are never in `existing`", () => {
  // Seed the existing set with many codes; the batch must skip them all.
  const existing = new Set<string>();
  const r = seeded(11);
  for (let i = 0; i < 50; i++) existing.add(nextMainBarcode(existing, r));
  const rows = [{ barcode: "" }, { barcode: "" }, { barcode: "" }];
  const out = fillMissingVariantBarcodes(rows, existing, seeded(99));
  for (const c of out) assert.equal(existing.has(c), false, "no collision with existing");
});

test("copy product price fills ONLY empty variant prices", () => {
  assert.deepEqual(
    copyProductPriceToEmpty("10", [{ price: "" }, { price: "5" }, { price: "" }]),
    ["10", "5", "10"],
  );
});

test("generate all missing = fill empty sku + empty barcode, existing untouched", () => {
  const rows = [
    { sku: "mk50-1", barcode: "1234567890128" },
    { sku: "", barcode: "" },
  ];
  const out = generateAllMissingIdentity("mk50", rows, new Set(), seeded(5), []);
  assert.equal(out.skus[0], "mk50-1", "existing sku kept");
  assert.equal(out.barcodes[0], "1234567890128", "existing barcode kept");
  assert.equal(out.skus[1], "mk50-2");
  assert.ok(isValidEan13(out.barcodes[1]));
});

test("empty input is a no-op", () => {
  assert.deepEqual(fillMissingVariantSkus("mk1", []), []);
  assert.deepEqual(fillMissingVariantBarcodes([], new Set(), seeded()), []);
  assert.deepEqual(copyProductPriceToEmpty("9", []), []);
});

// ── guards: reuse only, no I/O, both forms share helpers, confirm on overwrite ─

test("identity-fill re-implements NOTHING — it only composes the existing generators", () => {
  const SRC = readFileSync(new URL("./identity-fill.ts", import.meta.url), "utf8");
  assert.ok(SRC.includes('from "./sku-generate.ts"'), "reuses sku-generate");
  assert.ok(SRC.includes('from "./barcode-ean13.ts"'), "reuses barcode-ean13");
  // no re-implemented regexes / EAN math
  assert.equal(/\/\^mk/.test(SRC), false, "no SKU regex");
  assert.equal(/\[0-9\]\{6,14\}|\\d\{13\}/.test(SRC), false, "no barcode regex");
  assert.equal(/checkDigit|% 10|10 -/.test(SRC), false, "no EAN check-digit math");
});

test("identity-fill does no I/O and no writes", () => {
  const SRC = readFileSync(new URL("./identity-fill.ts", import.meta.url), "utf8");
  for (const bad of ["createClient", "supabase", "fetch(", ".from(", ".insert(", ".update(", ".rpc("]) {
    assert.equal(SRC.includes(bad), false, `must not contain ${bad}`);
  }
});

test("the identity action is READ-ONLY (reuses loadIdentitySnapshot; no writes/RPC)", () => {
  const SRC = readFileSync(new URL("../../app/(v2)/v2/catalog/identity-actions.ts", import.meta.url), "utf8");
  assert.ok(SRC.includes('"use server"'), "server action");
  assert.ok(SRC.includes("loadIdentitySnapshot"), "reuses the existing snapshot reader");
  assert.ok(SRC.includes("isSignedIn"), "re-checks the session");
  for (const bad of [".insert(", ".update(", ".upsert(", ".delete(", ".rpc("]) {
    assert.equal(SRC.includes(bad), false, `action must not ${bad}`);
  }
});

test("create + edit share the SAME identity path via the shared hook (UX.4E-2)", () => {
  const CREATE = readFileSync(new URL("../../components/v2/catalog/AiProductCreator.tsx", import.meta.url), "utf8");
  const EDIT = readFileSync(new URL("../../components/v2/catalog/ProductEditForm.tsx", import.meta.url), "utf8");
  const HOOK = readFileSync(new URL("../../components/v2/catalog/useVariantIdentity.ts", import.meta.url), "utf8");

  // Both editors now share ONE orchestration path: the useVariantIdentity hook +
  // the same toolbar. The generator logic no longer lives in the components.
  for (const src of [CREATE, EDIT]) {
    assert.ok(src.includes("useVariantIdentity({"), "uses the shared identity hook");
    assert.ok(src.includes("VariantIdentityToolbar"), "renders the shared toolbar");
  }

  // The hook is the single place that reaches the shared helpers, the read
  // action, and the overwrite confirmation (fill-missing never confirms).
  assert.ok(HOOK.includes('from "@/lib/products/identity-fill"'), "hook imports the shared helpers");
  assert.ok(HOOK.includes("loadCatalogIdentity"), "hook uses the shared read action");
  assert.ok(HOOK.includes("window.confirm"), "hook confirms before overwrite");
});
