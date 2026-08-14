// INV.4B — pure authoritative variant zero-crossing planner + source guard that
// logAuthoritativeVariantTransition (the DB-firing surface in transition.ts) uses
// the task openers and NEVER re-reads the double-counting totalStock helper.
//
// PURE — Run:
// node --conditions=react-server --experimental-strip-types --test lib/inventory/variant-transition-plan.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { planAuthoritativeVariantTransition, planStockTransition } from "./variant-transition-plan.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

// ── planner: parent crossing wins ─────────────────────────────────────────────

test("parent >0 → 0 opens a product OOS task", () => {
  const p = planAuthoritativeVariantTransition({ variantBefore: 3, variantAfter: 0, parentBefore: 3, parentAfter: 0 });
  assert.deepEqual(p, { level: "product", action: "oos" });
});

test("parent 0 → >0 opens a product restock task", () => {
  const p = planAuthoritativeVariantTransition({ variantBefore: 0, variantAfter: 5, parentBefore: 0, parentAfter: 5 });
  assert.deepEqual(p, { level: "product", action: "restock" });
});

// ── planner: parent stays put, the variant itself crosses ─────────────────────

test("parent stays >0 while a variant >0 → 0 opens a variant OOS task", () => {
  // one option ran out (4 → 0) but siblings keep the parent at 6.
  const p = planAuthoritativeVariantTransition({ variantBefore: 4, variantAfter: 0, parentBefore: 10, parentAfter: 6 });
  assert.deepEqual(p, { level: "variant", action: "oos" });
});

test("parent stays >0 while a variant 0 → >0 opens a variant restock task", () => {
  const p = planAuthoritativeVariantTransition({ variantBefore: 0, variantAfter: 3, parentBefore: 6, parentAfter: 9 });
  assert.deepEqual(p, { level: "variant", action: "restock" });
});

// ── planner: no crossing = no task ────────────────────────────────────────────

test("no zero crossing on either level → no task", () => {
  assert.deepEqual(planAuthoritativeVariantTransition({ variantBefore: 5, variantAfter: 8, parentBefore: 12, parentAfter: 15 }), { level: "none" });
  assert.deepEqual(planAuthoritativeVariantTransition({ variantBefore: 8, variantAfter: 5, parentBefore: 15, parentAfter: 12 }), { level: "none" });
  // an unchanged move (no delta) never crosses.
  assert.deepEqual(planAuthoritativeVariantTransition({ variantBefore: 3, variantAfter: 3, parentBefore: 3, parentAfter: 3 }), { level: "none" });
});

test("parent crossing supersedes a simultaneous variant crossing", () => {
  // The last option runs out AND that drops the parent to zero → product-level.
  const p = planAuthoritativeVariantTransition({ variantBefore: 2, variantAfter: 0, parentBefore: 2, parentAfter: 0 });
  assert.deepEqual(p, { level: "product", action: "oos" });
});

test("the <= 0 threshold matches the legacy path (negative treated as out)", () => {
  // a corrected negative → positive is a restock crossing.
  const p = planAuthoritativeVariantTransition({ variantBefore: -1, variantAfter: 2, parentBefore: -1, parentAfter: 2 });
  assert.deepEqual(p, { level: "product", action: "restock" });
});

// ── planStockTransition (product-level, INV.4C) ───────────────────────────────

test("planStockTransition: >0 → 0 = oos, 0 → >0 = restock, else null", () => {
  assert.equal(planStockTransition({ before: 5, after: 0 }), "oos");
  assert.equal(planStockTransition({ before: 0, after: 5 }), "restock");
  assert.equal(planStockTransition({ before: 5, after: 3 }), null); // no crossing
  assert.equal(planStockTransition({ before: 0, after: 0 }), null);
  assert.equal(planStockTransition({ before: 3, after: 3 }), null); // no delta
  // negative treated as out (matches legacy <= 0 threshold)
  assert.equal(planStockTransition({ before: -2, after: 4 }), "restock");
});

// ── source guard: the DB-firing surface never uses totalStock ──────────────────

function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
function fnBody(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}`);
  if (start < 0) return "";
  const after = src.indexOf("\nexport ", start + 1);
  return code(src.slice(start, after < 0 ? src.length : after));
}

test("logAuthoritativeVariantTransition fires tasks but never re-reads totalStock", () => {
  const TRANSITION = readFileSync(join(ROOT, "lib/inventory/transition.ts"), "utf8");
  const body = fnBody(TRANSITION, "logAuthoritativeVariantTransition");
  assert.ok(body.length > 0, "located logAuthoritativeVariantTransition");
  assert.ok(/planAuthoritativeVariantTransition\(/.test(body), "delegates the decision to the pure planner");
  assert.ok(/openStockTask\(/.test(body), "opens the product-level task");
  assert.ok(/openVariantStockTask\(/.test(body), "opens the option-scoped task");
  assert.equal(/totalStock/.test(body), false, "never calls totalStock (INV.3B double-count avoided)");
  // best-effort: the whole body is wrapped in a try/catch so a task failure never
  // propagates back to undo the stock mutation.
  assert.ok(/try\s*\{/.test(body) && /catch\s*\(/.test(body), "best-effort try/catch");
});

test("logAuthoritativeStockTransition fires the product task but never uses totalStock", () => {
  const TRANSITION = readFileSync(join(ROOT, "lib/inventory/transition.ts"), "utf8");
  const body = fnBody(TRANSITION, "logAuthoritativeStockTransition");
  assert.ok(body.length > 0, "located logAuthoritativeStockTransition");
  assert.ok(/planStockTransition\(/.test(body), "delegates to the pure planner");
  assert.ok(/openStockTask\(/.test(body), "opens the product-level task");
  assert.equal(/totalStock/.test(body), false, "never calls totalStock");
  assert.ok(/try\s*\{/.test(body) && /catch\s*\(/.test(body), "best-effort try/catch");
});

test("the legacy totalStock + logVariantStockTransition are left intact for legacy callers", () => {
  const TRANSITION = readFileSync(join(ROOT, "lib/inventory/transition.ts"), "utf8");
  assert.ok(/logVariantStockTransition/.test(TRANSITION), "legacy variant transition still re-exported");
  assert.ok(/totalStock/.test(TRANSITION), "legacy totalStock still re-exported");
});
