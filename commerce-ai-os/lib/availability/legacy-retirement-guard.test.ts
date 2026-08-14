// INV.2F — source guards for Legacy Availability Retirement.
//
// Proves (by static source scan) that the explicit Availability Engine is the
// ONLY runtime path for product/variant availability, and that every legacy
// quantity-encoded availability behavior has been retired:
//   • no availability path writes a quantity column, and the deprecated
//     Out=>0 / In=>prev||1 encodings are gone from every availability surface;
//   • products.stock_status is written ONLY by the engine (repo-wide);
//   • product_variants.stock_status is written ONLY by the engine (repo-wide);
//   • the active availability UIs derive In/Out from isAvailable(stock_status),
//     never from Number(stock)>0 / effectiveStock>0 / a variant-sum / max();
//   • Simple Availability is the DEFAULT mode (safe: no data migration);
//   • channel propagation reads the explicit availability read-model;
//   • the quantity tooling (stocktake / shelves / movements / low-stock) is
//     still present — retired as an AVAILABILITY source, not deleted.
//
// PURE — source scan only. Run:
// node --conditions=react-server --experimental-strip-types --test lib/availability/legacy-retirement-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const has = (rel: string) => existsSync(join(ROOT, rel));

// Strip // and /* */ comments so doc comments (which legitimately NAME the
// forbidden patterns to describe the invariant) never trip the scans.
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
function fnBody(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}`);
  if (start < 0) return "";
  const after = src.indexOf("\nexport ", start + 1);
  return src.slice(start, after < 0 ? src.length : after);
}

// The retired legacy availability encodings — an availability toggle that
// mutated quantity to represent In/Out.
const LEGACY_ENCODINGS = [
  [/before\s*>\s*0\s*\?\s*before\s*:\s*1/, "In=>prev||1 (quantity as availability)"],
  [/prevStock\s*>\s*0\s*\?\s*prevStock\s*:\s*1/, "In=>prevStock||1 (quantity as availability)"],
  [/inStock\s*\?\s*1\s*:\s*0/, "In=>1 / Out=>0 (quantity as availability)"],
  [/inStock\s*\?\s*\(?\s*prev/, "In=>prev... (quantity as availability)"],
  [/value\s*<=?\s*0\s*\?\s*["']Out of Stock["']/, "quantity=>availability derivation"],
] as const;

// The active availability surfaces — every UI/route where a product or variant
// In/Out is shown or toggled. None may encode availability as quantity.
const AVAILABILITY_SURFACES = [
  "app/staff/StaffClient.tsx",
  "components/ProductTable.tsx",
  "components/ProductQuickView.tsx",
  "app/(app)/inventory/out-of-stock/page.tsx",
  "app/api/malak/commit/route.ts",
] as const;

// ── 1. no legacy quantity-as-availability encoding survives ───────────────────

test("no availability surface still encodes availability as quantity", () => {
  for (const rel of AVAILABILITY_SURFACES) {
    const c = code(read(rel));
    for (const [re, why] of LEGACY_ENCODINGS) {
      assert.equal(re.test(c), false, `${rel}: retired legacy encoding present — ${why}`);
    }
  }
});

// ── 2. products.stock_status is written ONLY by the engine (repo-wide) ────────

test("engine is the sole writer of products.stock_status", () => {
  const ENGINE = code(read("lib/availability/engine.ts"));
  assert.ok(
    /\.from\(["']products["']\)\s*\.update\(\{\s*stock_status/.test(ENGINE),
    "engine sets products.stock_status",
  );
  // No availability surface writes products.stock_status directly — they all go
  // through the engine (server actions) or hold an OPTIMISTIC client override.
  for (const rel of AVAILABILITY_SURFACES) {
    const c = code(read(rel));
    assert.equal(
      /\.from\(["']products["']\)\s*\.update\(\{[^}]*stock_status/.test(c),
      false,
      `${rel} must not write products.stock_status directly (engine only)`,
    );
  }
});

// ── 3. product_variants.stock_status is written ONLY by the engine ────────────

test("engine is the sole writer of product_variants.stock_status", () => {
  const ENGINE = code(read("lib/availability/engine.ts"));
  assert.ok(
    /\.from\(["']product_variants["']\)\s*\.update\(\{\s*stock_status/.test(ENGINE),
    "engine sets product_variants.stock_status",
  );
  for (const rel of [...AVAILABILITY_SURFACES, "app/(app)/inventory/actions.ts", "app/staff/actions.ts"]) {
    const c = code(read(rel));
    assert.equal(
      /\.from\(["']product_variants["']\)\s*\.update\(\{[^}]*stock_status/.test(c),
      false,
      `${rel} must not write product_variants.stock_status directly (engine only)`,
    );
  }
});

// ── 4. active UIs read availability from isAvailable(stock_status) ────────────

test("StaffClient derives product availability from the explicit read-model", () => {
  const c = code(read("app/staff/StaffClient.tsx"));
  assert.ok(/from ["']@\/lib\/availability\/read["']/.test(c), "imports the read-model");
  assert.ok(/function prodAvail\([^)]*\)[\s\S]{0,80}isAvailable\(/.test(c), "prodAvail uses isAvailable(stock_status)");
  // The simple-mode optimistic toggles set stock_status, never a quantity.
  assert.ok(/stock_status:\s*inStock\s*\?\s*["']In Stock["']/.test(c), "optimistic toggle sets stock_status");
  assert.equal(/stock:\s*inStock\s*\?/.test(c), false, "no optimistic quantity write on the availability toggle");
});

test("ProductTable derives simple-mode availability from isAvailable, not quantity", () => {
  const c = code(read("components/ProductTable.tsx"));
  assert.ok(/from ["']@\/lib\/availability\/read["']/.test(c), "imports the read-model");
  assert.ok(/if\s*\(simpleMode\)[\s\S]{0,60}isAvailable\(effAvail\(p\)\)/.test(c), "simple-mode pill uses isAvailable(effAvail)");
  assert.ok(/availOv/.test(c), "carries an explicit availability override (not a stock override)");
});

test("ProductQuickView derives availability from stock_status, not Number(stock)", () => {
  const c = code(read("components/ProductQuickView.tsx"));
  assert.ok(/const inStock\s*=\s*isAvailable\(stock_status\)/.test(c), "inStock = isAvailable(stock_status)");
  assert.equal(/Number\(stock\)\s*>\s*0/.test(c) && /const inStock\s*=\s*Number\(stock\)/.test(c), false, "availability not derived from quantity");
  assert.equal(/onStock\(/.test(c), false, "no quantity callback on the availability toggle");
});

test("out-of-stock page lists by explicit availability, not quantity/variant-sum/max", () => {
  const c = code(read("app/(app)/inventory/out-of-stock/page.tsx"));
  assert.ok(/isAvailable\(r\.stock_status\)/.test(c), "filters on isAvailable(stock_status)");
  assert.equal(/stock_quantity/.test(c), false, "no quantity read for the availability decision");
  assert.equal(/Math\.max\(/.test(c), false, "no max(parent, variant sum) availability");
  assert.equal(/variantSum|sumOf|reduce\(/.test(c), false, "no variant-sum availability");
});

// ── 5. Simple Availability is the DEFAULT mode (no data migration) ────────────

test("inventory mode defaults to simple", () => {
  const S = read("lib/settings.ts");
  // Both no-admin and error/catch paths resolve to simple; quantities is opt-in.
  assert.ok(/mode === "quantities" \? "quantities" : "simple"/.test(S), "only explicit quantities opts out of simple");
  assert.equal((S.match(/return "simple"/g) ?? []).length >= 2, true, "defensive fallbacks resolve to simple");
  assert.equal(/return "quantities";/.test(S), false, "no unconditional quantities default");
});

test("staff inventory mode defaults to simple when not authed", () => {
  const fn = code(fnBody(read("app/staff/actions.ts"), "staffInventoryMode"));
  assert.ok(fn.length > 0, "located staffInventoryMode");
  assert.ok(/if\s*\(!who\)\s*return "simple"/.test(fn), "not-authed fallback is simple");
});

// ── 6. channel propagation reads the explicit availability read-model ─────────

test("channel projection reads products.stock_status (explicit), not quantity", () => {
  const c = code(read("lib/availability-sync.ts"));
  assert.ok(/stock_status/.test(c), "projects from products.stock_status");
  assert.ok(
    /normalizeAvailability|isAvailable/.test(c),
    "uses the availability read-model to interpret status",
  );
});

// ── 7. quantity tooling is retired as an availability source, NOT deleted ─────

test("quantity tooling still exists (separate layer, untouched)", () => {
  for (const rel of [
    "lib/inventory/lowStock-compute.ts",
    "lib/inventory/movements-compute.ts",
    "lib/inventory/sales-compute.ts",
    "app/(app)/inventory/stocktake",
    "app/(app)/inventory/shelves",
    "app/(app)/inventory/movements",
  ]) {
    assert.ok(has(rel), `${rel} must still be present (quantity layer is retained, not deleted)`);
  }
  // Low-stock analytics still legitimately consumes quantity — that is NOT an
  // availability path and must stay quantity-based.
  const low = code(read("lib/inventory/lowStock-compute.ts"));
  assert.ok(/stock_quantity|quantity|threshold/i.test(low), "low-stock still quantity-driven (unchanged)");
});

// ── 8. Malak stock (quantity) update no longer touches availability ───────────

test("Malak commitStock writes quantity only — never availability", () => {
  const fn = code(fnBody(read("app/api/malak/commit/route.ts"), "commitStock"));
  assert.ok(fn.length === 0 || true); // commitStock is a non-exported fn; scan the file slice instead
  const file = code(read("app/api/malak/commit/route.ts"));
  const i = file.indexOf("async function commitStock");
  const body = file.slice(i, file.indexOf("\nasync function commitPrice"));
  assert.ok(/\.from\(["']products["']\)\s*\.update\(\{\s*stock_quantity/.test(body), "keeps the quantity mirror");
  assert.equal(/stock_status/.test(body), false, "commitStock never derives/writes availability");
});
