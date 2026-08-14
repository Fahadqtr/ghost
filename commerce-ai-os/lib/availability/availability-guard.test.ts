// INV.2C — Source guards for the Availability Engine migration.
//
// Proves (by static source scan):
//  • engine.ts is the sole product-availability writer (products.stock_status)
//    and never writes a quantity/shelf/sold column or touches a channel;
//  • read.ts is pure;
//  • the migrated manager + staff product toggles delegate to the engine and
//    contain NO quantity writes and none of the deprecated destructive patterns;
//  • variant availability is explicitly deferred (non-destructive, no quantity);
//  • the inventory simple-mode UI reads availability from read.ts, not from
//    effective quantity;
//  • no channel/overlay writer was moved into 2C.
//
// PURE — source scan only.
// Run: node --conditions=react-server --experimental-strip-types --test lib/availability/availability-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

// Strip // and /* */ comments so doc comments (which legitimately NAME forbidden
// tables to describe the invariant) never trip the "must not contain" scans.
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
function fnBody(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}`);
  if (start < 0) return "";
  const after = src.indexOf("\nexport ", start + 1);
  return src.slice(start, after < 0 ? src.length : after);
}

const FORBIDDEN_WRITE = [
  [/stock_quantity\s*:/, "stock_quantity write"],
  [/sold_quantity\s*:/, "sold_quantity write"],
  [/\.from\(["'](shelf_stock|variant_shelf_stock)["']\)/, "shelf table write"],
  [/before\s*>\s*0\s*\?\s*before\s*:\s*1/, "deprecated In=>prev||1"],
  [/inStock\s*\?\s*1\s*:\s*0/, "deprecated Out=>0 / In=>1"],
] as const;

function assertNoQuantityWrite(body: string, label: string) {
  for (const [re, why] of FORBIDDEN_WRITE) {
    assert.equal(re.test(body), false, `${label}: must not contain ${why}`);
  }
}

// ── engine.ts ─────────────────────────────────────────────────────────────────

test("engine writes ONLY products.stock_status", () => {
  const ENGINE = code(read("lib/availability/engine.ts"));
  assert.ok(/\.from\(["']products["']\)\s*\.update\(\{\s*stock_status/.test(ENGINE), "engine sets products.stock_status");
  for (const t of ["inventory", "product_variants", "shelf_stock", "variant_shelf_stock"]) {
    assert.equal(new RegExp(`\\.from\\(["']${t}["']\\)`).test(ENGINE), false, `engine must not touch ${t}`);
  }
  assertNoQuantityWrite(ENGINE, "engine");
});

test("engine performs NO channel propagation", () => {
  const ENGINE = code(read("lib/availability/engine.ts"));
  assert.equal(/\.from\(["'](platform_status|channel_products)["']\)/.test(ENGINE), false, "no channel table writes");
  assert.equal(/shopify|talabat/i.test(ENGINE), false, "no Shopify/Talabat propagation in the engine");
});

test("read.ts is pure (no @/ / DB / react / next / server-only)", () => {
  const R = read("lib/availability/read.ts");
  assert.equal(/from\s+["']@\//.test(R), false, "no @/ imports");
  assert.equal(/from\s+["'](react|next|@supabase|server-only)/.test(R), false, "no framework/DB imports");
  assert.equal(/createClient|createAdminClient/.test(R), false, "no DB client");
});

// ── manager toggles (inventory/actions.ts) ────────────────────────────────────

const INV = read("app/(app)/inventory/actions.ts");

test("inventory actions import the engine", () => {
  assert.ok(INV.includes('from "@/lib/availability/engine"'), "imports the engine");
});

test("setProductAvailability delegates to the engine; no quantity write", () => {
  const fn = code(fnBody(INV, "setProductAvailability"));
  assert.ok(fn.length > 0, "located setProductAvailability");
  assert.ok(/setProductAvailabilityState\(/.test(fn), "calls the engine");
  assert.equal(/\.from\(["'](inventory|products)["']\)/.test(fn), false, "does not write inventory/products directly");
  assertNoQuantityWrite(fn, "setProductAvailability");
});

test("setManyAvailability delegates to the engine; no quantity write", () => {
  const fn = code(fnBody(INV, "setManyAvailability"));
  assert.ok(/writeProductAvailability\(/.test(fn), "calls the engine");
  assert.equal(/\.lte\(/.test(fn), false, "no stock_quantity guard remains");
  assert.equal(/\.from\(["'](inventory|products)["']\)/.test(fn), false, "no direct table write");
  assertNoQuantityWrite(fn, "setManyAvailability");
});

test("setVariantAvailability is a deferred non-destructive no-op (INV.2E)", () => {
  const fn = code(fnBody(INV, "setVariantAvailability"));
  assert.ok(/INV\.2E/.test(fnBody(INV, "setVariantAvailability")), "marked deferred to INV.2E");
  assert.equal(/\.update\(/.test(fn), false, "no DB write");
  assertNoQuantityWrite(fn, "setVariantAvailability");
});

// ── staff toggles (staff/actions.ts) ──────────────────────────────────────────

const STAFF = read("app/staff/actions.ts");

test("staff actions import the engine", () => {
  assert.ok(STAFF.includes('from "@/lib/availability/engine"'), "imports the engine");
});

for (const name of ["staffSetAvailability", "staffSetAvailabilityInv", "staffSetManyAvailability"]) {
  test(`${name} delegates to the engine; no quantity write`, () => {
    const fn = code(fnBody(STAFF, name));
    assert.ok(fn.length > 0, `located ${name}`);
    assert.ok(/setProductAvailabilityState\(|writeProductAvailability\(/.test(fn), "calls the engine");
    assertNoQuantityWrite(fn, name);
  });
}

test("staffSetVariantAvailability is a deferred non-destructive no-op", () => {
  const fn = code(fnBody(STAFF, "staffSetVariantAvailability"));
  assert.equal(/\.update\(/.test(fn), false, "no DB write");
  assertNoQuantityWrite(fn, "staffSetVariantAvailability");
});

// ── inventory simple-mode UI reads availability from the read-model ───────────

test("inventory page reads product availability from read.ts, not effective quantity", () => {
  const PAGE = read("app/(app)/inventory/page.tsx");
  assert.ok(/from ["']@\/lib\/availability\/read["']/.test(PAGE), "imports the read-model");
  const i = PAGE.indexOf("const availabilityRows");
  const block = PAGE.slice(i, PAGE.indexOf("return (", i));
  assert.ok(/in_stock:\s*isAvailable\(/.test(block), "product in_stock derives from isAvailable(stock_status)");
  assert.equal(/in_stock:\s*effectiveStock/.test(block), false, "no effective-stock availability on the migrated surface");
});

// ── no channel/overlay writer moved into 2C (engine stays availability-only) ──

test("the availability module touches no channel/overlay writer", () => {
  for (const rel of ["lib/availability/engine.ts", "lib/availability/read.ts"]) {
    const src = code(read(rel));
    assert.equal(/platform_status|channel_products|pushInventoryStockToShopify|runShopifyInventorySync/.test(src), false, `${rel} has no channel writer`);
  }
});
