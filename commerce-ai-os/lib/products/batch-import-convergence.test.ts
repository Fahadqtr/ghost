// P7/P8 — Snoonu + Pure Seoul batch import convergence guards + regressions.
// Proves both importers delegate product/inventory writes to createProductsBatchCore
// while every wrapper concern (identity, dedup, barcode range, skipped, response
// shape, revalidate) is preserved — and that the other create paths are untouched.
//
// PURE — source scan only.
//
// Run: node --conditions=react-server --experimental-strip-types --test lib/products/batch-import-convergence.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/** Slice a single exported async function body: from its declaration to the next
 *  top-level `export ` (or end of file). */
function fnBody(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}`);
  if (start < 0) return "";
  const after = src.indexOf("\nexport ", start + 1);
  return src.slice(start, after < 0 ? src.length : after);
}

const SNOONU_SRC = read("app/(app)/import-export/snoonu-actions.ts");
const PS_SRC = read("app/(app)/import-export/pure-seoul-actions.ts");
const SNOONU = fnBody(SNOONU_SRC, "addSnoonuNewProducts");
const PS = fnBody(PS_SRC, "addPureSeoulNewProducts");

// ── Snoonu wrapper ────────────────────────────────────────────────────────────

test("Snoonu: delegates writes to createProductsBatchCore; no direct product/inventory insert", () => {
  assert.ok(SNOONU.length > 0, "located addSnoonuNewProducts");
  assert.ok(/createProductsBatchCore\(admin, toInsert, \{ seedQuantity: 0 \}\)/.test(SNOONU), "calls the batch core");
  assert.ok(SNOONU_SRC.includes('from "@/lib/products/product-create-batch"'), "imports the batch core");
  assert.equal(/from\(["']products["']\)\s*\.insert/.test(SNOONU), false, "no direct products.insert");
  assert.equal(/from\(["']inventory["']\)\s*\.insert/.test(SNOONU), false, "no direct inventory.insert");
});

test("Snoonu: identity, dedup, barcode range, skipped, response, revalidate preserved", () => {
  assert.ok(/nextMkSku\(/.test(SNOONU), "SKU via nextMkSku");
  assert.ok(/"29"\s*\+/.test(SNOONU), "29-prefix barcode kept");
  assert.ok(/existing\.has\(id\)/.test(SNOONU) && /seen\.has\(id\)/.test(SNOONU), "snoonu_id + in-batch dedup kept");
  assert.ok(/skipped\+\+/.test(SNOONU), "skipped count kept");
  assert.ok(/return \{ ok: true, added: res\.added, skipped, failed: res\.failed \}/.test(SNOONU), "ok:true response shape kept");
  assert.ok(/revalidatePath\("\/products"\)/.test(SNOONU) && /revalidatePath\("\/import-export\/snoonu-sync"\)/.test(SNOONU), "revalidatePath kept");
  assert.ok(/createAdminClient\(\)/.test(SNOONU), "admin client kept");
});

// ── Pure Seoul wrapper ────────────────────────────────────────────────────────

test("Pure Seoul: delegates writes to createProductsBatchCore; no direct product/inventory insert", () => {
  assert.ok(PS.length > 0, "located addPureSeoulNewProducts");
  assert.ok(/createProductsBatchCore\(admin, toInsert, \{ seedQuantity: 0 \}\)/.test(PS), "calls the batch core");
  assert.ok(PS_SRC.includes('from "@/lib/products/product-create-batch"'), "imports the batch core");
  assert.equal(/from\(["']products["']\)\s*\.insert/.test(PS), false, "no direct products.insert");
  assert.equal(/from\(["']inventory["']\)\s*\.insert/.test(PS), false, "no direct inventory.insert");
});

test("Pure Seoul: identity, exact+fuzzy dedup, missing-column guard, skipped, response, revalidate preserved", () => {
  assert.ok(/nextMkSku\(/.test(PS), "SKU via nextMkSku");
  assert.ok(/"29"\s*\+/.test(PS), "29-prefix barcode kept");
  assert.ok(/existingPsId\.has\(spi\)/.test(PS), "pure_seoul_id dedup kept");
  assert.ok(/byName\.has\(nn\)/.test(PS), "exact-name dedup kept");
  assert.ok(/jaccard\(/.test(PS) && /isSubset\(/.test(PS), "fuzzy token/Jaccard matching kept");
  assert.ok(/pure_seoul_id/.test(PS) && /pure_seoul_id\.sql/.test(PS), "missing-column guard kept");
  assert.ok(/skipped\+\+/.test(PS), "skipped count kept");
  assert.ok(/return \{ ok: res\.failed === 0, added: res\.added, skipped, failed: res\.failed \}/.test(PS), "ok:failed===0 response shape kept");
  assert.ok(/revalidatePath\("\/products"\)/.test(PS) && /revalidatePath\("\/import-export\/pure-seoul"\)/.test(PS), "revalidatePath kept");
});

// ── Regression: other paths unchanged ─────────────────────────────────────────

test("Shopify + Malak stay on the SINGLE-product core (not the batch core)", () => {
  for (const rel of ["app/(app)/import-export/shopify-actions.ts", "app/api/malak/commit/route.ts"]) {
    const src = read(rel);
    assert.ok(/createProductCore\(/.test(src), `${rel} still uses createProductCore`);
    assert.equal(/createProductsBatchCore/.test(src), false, `${rel} does not use the batch core`);
  }
});

test("V2 Create + Import still use createProductCore with the session client", () => {
  for (const rel of ["app/(v2)/v2/catalog/new/actions.ts", "app/(v2)/v2/catalog/[id]/edit/actions.ts"]) {
    // new uses createProductCore; edit uses updateProductCore — both must not touch the batch core.
    assert.equal(/createProductsBatchCore/.test(read(rel)), false, `${rel} does not use the batch core`);
  }
  assert.ok(/createProductCore\(supabase,/.test(read("app/(v2)/v2/catalog/new/actions.ts")), "V2 create injects the session client");
});

test("Archive restore stays exempt; Staff stays direct — neither uses any create core", () => {
  for (const rel of ["app/(app)/products/archive/actions.ts", "app/staff/actions.ts"]) {
    const src = read(rel);
    assert.equal(/createProductCore\(/.test(src), false, `${rel} does not use the single core`);
    assert.equal(/createProductsBatchCore/.test(src), false, `${rel} does not use the batch core`);
  }
});

// ── The batch core is used ONLY by Snoonu + Pure Seoul ────────────────────────

test("createProductsBatchCore has exactly two runtime callers (Snoonu, Pure Seoul)", () => {
  const callers = ["app/(app)/import-export/snoonu-actions.ts", "app/(app)/import-export/pure-seoul-actions.ts"];
  for (const rel of callers) assert.ok(/createProductsBatchCore\(/.test(read(rel)), `${rel} calls the batch core`);
  // Nothing else imports it (spot-check the other create paths).
  for (const rel of [
    "app/(app)/import-export/shopify-actions.ts",
    "app/api/malak/commit/route.ts",
    "app/staff/actions.ts",
    "app/(app)/products/archive/actions.ts",
    "app/(v2)/v2/catalog/new/actions.ts",
  ]) {
    assert.equal(/createProductsBatchCore/.test(read(rel)), false, `${rel} must not use the batch core`);
  }
});
