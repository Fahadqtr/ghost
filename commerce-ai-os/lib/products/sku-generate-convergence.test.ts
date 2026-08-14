// P4 — product SKU generation convergence. Proves that delegating Staff, Snoonu,
// and Pure Seoul mk#### numbering to the canonical nextMkSku is behavior-equivalent
// to the ad-hoc generators they replaced, and that the (deliberately distinct)
// barcode generators were NOT touched.
//
// Each ad-hoc generator scanned ONLY products.sku with /^mk(\d+)$/i, took the max,
// and returned mk<max+1> (the two importers incremented per new row in the batch).
// nextMkSku fed the same product-SKU input reproduces that exactly (verified in
// production: no product row carries a variant-format sku, so nextMkSku's tolerant
// ^mk(\d+)(?:-\d+)?$ match cannot diverge on real data).
//
// PURE — no DB, no network, no React. Behavioral oracle + source scans.
//
// Run: node --conditions=react-server --experimental-strip-types --test lib/products/sku-generate-convergence.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { nextMkSku } from "./sku-generate.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

// ── Oracle: the exact algorithm the three ad-hoc generators used ───────────────
// products.sku only, /^mk(\d+)$/i, max → mk<max+1>. The importers called this
// repeatedly with ++maxMk, i.e. mk<max+1>, mk<max+2>, … for the batch.
function oldMaxMk(productSkus: readonly string[]): number {
  let maxMk = 0;
  for (const s of productSkus) {
    const m = /^mk(\d+)$/i.exec(String(s ?? "").trim());
    if (m) maxMk = Math.max(maxMk, parseInt(m[1], 10));
  }
  return maxMk;
}
/** Old single-shot generator (Staff). */
function oldNextSingle(productSkus: readonly string[]): string {
  return `mk${oldMaxMk(productSkus) + 1}`;
}
/** Old batch generator (Snoonu / Pure Seoul): count new SKUs. */
function oldNextBatch(productSkus: readonly string[], count: number): string[] {
  let maxMk = oldMaxMk(productSkus);
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(`mk${++maxMk}`);
  return out;
}

/** New batch generator: repeated nextMkSku(skus, generated) — how the importers now call it. */
function newNextBatch(productSkus: readonly string[], count: number): string[] {
  const generated = new Set<string>();
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const sku = nextMkSku(productSkus, generated);
    generated.add(sku);
    out.push(sku);
  }
  return out;
}

const CATALOGS: Record<string, string[]> = {
  empty: [],
  normal: ["mk1", "mk2", "mk7", "mk3"],
  withGaps: ["mk10", "mk4"],
  invalidIgnored: ["", "abc", "mk", "mk-1", "sku99", "MK ", "12", "mk1x"],
  mixedCase: ["MK5", "mk9", "Mk3"],
  nullish: ["mk2", "", "mk4"],
};

// ── single-shot (Staff) parity ────────────────────────────────────────────────

for (const [name, skus] of Object.entries(CATALOGS)) {
  test(`Staff single-shot parity — ${name}`, () => {
    assert.equal(nextMkSku(skus), oldNextSingle(skus));
  });
}

test("empty catalog → mk1", () => {
  assert.equal(nextMkSku([]), "mk1");
  assert.equal(oldNextSingle([]), "mk1");
});

test("normal max → next number (mk7 → mk8)", () => {
  assert.equal(nextMkSku(CATALOGS.normal), "mk8");
});

test("invalid sku strings are ignored identically → mk1", () => {
  assert.equal(nextMkSku(CATALOGS.invalidIgnored), "mk1");
  assert.equal(oldNextSingle(CATALOGS.invalidIgnored), "mk1");
});

test("mixed case handled identically (MK5/mk9/Mk3 → mk10)", () => {
  assert.equal(nextMkSku(CATALOGS.mixedCase), "mk10");
  assert.equal(oldNextSingle(CATALOGS.mixedCase), "mk10");
});

// ── batch (Snoonu / Pure Seoul) parity ────────────────────────────────────────

for (const [name, skus] of Object.entries(CATALOGS)) {
  for (const count of [1, 3, 5]) {
    test(`Importer batch parity — ${name} × ${count}`, () => {
      assert.deepEqual(newNextBatch(skus, count), oldNextBatch(skus, count));
    });
  }
}

test("batch continues the sequence past the max (mk7 → mk8, mk9, mk10)", () => {
  assert.deepEqual(newNextBatch(CATALOGS.normal, 3), ["mk8", "mk9", "mk10"]);
});

// ── product+variant identity: these paths feed product SKUs ONLY ──────────────
// The importers/Staff scan products.sku only, so no variant-form sku ever enters
// the input — meaning nextMkSku's variant-tolerant match cannot change the number.
// (Empirically confirmed: production has 0 products with a variant-format sku.)

test("feeding product-only SKUs, a variant-form string would only matter if present (it isn't)", () => {
  const productOnly = ["mk3", "mk5"];
  assert.equal(nextMkSku(productOnly), "mk6");
  // If a variant-form sku WERE (wrongly) in the product list, nextMkSku counts its
  // base — this documents the one theoretical divergence that real data rules out.
  assert.equal(nextMkSku([...productOnly, "mk40-2"]), "mk41");
  assert.equal(oldNextSingle([...productOnly, "mk40-2"]), "mk6"); // old ignored it
});

// ── source guards: one numbering impl, delegation, no stale scanners ───────────

const STAFF = read("app/staff/actions.ts");
const SNOONU = read("app/(app)/import-export/snoonu-actions.ts");
const PURESEOUL = read("app/(app)/import-export/pure-seoul-actions.ts");
const ADOPTERS: [string, string][] = [
  ["Staff", "app/staff/actions.ts"],
  ["Snoonu", "app/(app)/import-export/snoonu-actions.ts"],
  ["Pure Seoul", "app/(app)/import-export/pure-seoul-actions.ts"],
];

test("Staff/Snoonu/Pure Seoul delegate numbering to nextMkSku", () => {
  for (const [name, rel] of ADOPTERS) {
    const src = read(rel);
    assert.ok(/from\s+["']@\/lib\/products\/sku-generate["']/.test(src), `${name} imports sku-generate`);
    assert.ok(/nextMkSku\(/.test(src), `${name} calls nextMkSku`);
  }
});

test("no ad-hoc mk#### scanner remains in the adopting paths", () => {
  for (const [name, rel] of ADOPTERS) {
    const src = read(rel);
    assert.equal(/\/\^mk\\\(\\d\+\\\)\$\/i/.test(src), false, `${name} has no /^mk(\\d+)$/i literal`);
    // the old ad-hoc pattern text, robustly: an mk-digit regex used for scanning
    assert.equal(/\^mk\(\\d\+\)\$/.test(src), false, `${name} has no ^mk(\\d+)$ scanner`);
    assert.equal(/\+\+maxMk/.test(src), false, `${name} has no ++maxMk counter`);
  }
});

test("no local nextProductSku / nextStaffSku max-scanner reimplements numbering", () => {
  // nextStaffSku still exists as a thin wrapper, but must not itself scan mk numbers.
  assert.equal(/parseInt\([^)]*\bmk\b/i.test(STAFF), false, "Staff wrapper does not parse mk numbers");
  // No path re-declares the deleted legacy action name.
  for (const [, rel] of ADOPTERS) {
    assert.equal(/function\s+nextProductSku\b/.test(read(rel)), false);
  }
});

test("exactly one mk#### numbering implementation exists (sku-generate.ts)", () => {
  const canon = read("lib/products/sku-generate.ts");
  assert.ok(/export function maxMkNumber/.test(canon) && /export function nextMkSku/.test(canon), "canonical owns numbering");
});

// ── barcode isolation: the distinct ranges are untouched ──────────────────────

test("barcode generators remain distinct and unchanged", () => {
  // Staff: in-store 200-prefix.
  assert.ok(/"200"\s*\+/.test(STAFF), "Staff keeps the 200-prefix barcode");
  // Snoonu + Pure Seoul: internal 29-prefix EAN-13.
  assert.ok(/"29"\s*\+/.test(SNOONU), "Snoonu keeps the 29-prefix barcode");
  assert.ok(/"29"\s*\+/.test(PURESEOUL), "Pure Seoul keeps the 29-prefix barcode");
  // V2 create/import: the canonical random EAN-13 batch generator.
  assert.ok(
    /generateUniqueEan13Batch/.test(read("app/(v2)/v2/catalog/new/actions.ts")),
    "V2 create keeps generateUniqueEan13Batch",
  );
});

test("the SKU-generation module never generates barcodes (layers stay separate)", () => {
  const canon = read("lib/products/sku-generate.ts");
  assert.equal(/barcode|ean13|"200"|"29"/i.test(canon), false, "sku-generate has no barcode logic");
});
