// INV.2E — source guards for variant availability + the additive migration.
//
// PURE — source scan only. Run:
// node --conditions=react-server --experimental-strip-types --test lib/availability/variant-availability-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
function fnBody(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}`);
  if (start < 0) return "";
  const after = src.indexOf("\nexport ", start + 1);
  return src.slice(start, after < 0 ? src.length : after);
}

const ENGINE = code(read("lib/availability/engine.ts"));
const INV = read("app/(app)/inventory/actions.ts");
const STAFF = read("app/staff/actions.ts");

// ── engine is the SOLE writer of product_variants.stock_status ───────────────

test("engine exposes the variant availability writers", () => {
  assert.ok(/export async function writeVariantAvailability\(/.test(ENGINE));
  assert.ok(/export async function setVariantAvailabilityState\(/.test(ENGINE));
  assert.ok(/\.from\(["']product_variants["']\)\s*\.update\(\{\s*stock_status/.test(ENGINE), "engine sets product_variants.stock_status");
});

test("no runtime file other than the engine writes product_variants.stock_status", () => {
  // Repo-wide: the ONLY `product_variants .update({ stock_status ... })` lives in
  // the engine. Every other reference is a read (select) or a mapping.
  const files = [
    "app/(app)/inventory/actions.ts",
    "app/staff/actions.ts",
    "app/api/export/[channel]/route.ts",
    "lib/talabat/export.ts",
    "lib/products/product-save.ts",
  ];
  for (const rel of files) {
    const c = code(read(rel));
    assert.equal(
      /\.from\(["']product_variants["']\)\s*\.update\(\{[^}]*stock_status/.test(c),
      false,
      `${rel} must not write product_variants.stock_status directly (engine only)`,
    );
  }
});

// ── toggles delegate to the engine; write no variant quantity ────────────────

test("manager setVariantAvailability delegates to the engine, writes no quantity", () => {
  const fn = code(fnBody(INV, "setVariantAvailability"));
  assert.ok(/setVariantAvailabilityState\(/.test(fn), "calls the engine");
  assert.equal(/stock_quantity\s*:/.test(fn), false, "no variant quantity write");
  assert.equal(/\.from\(["']products["']\)/.test(fn), false, "does not touch the parent product (separate concept)");
});

test("staff staffSetVariantAvailability delegates to the engine, writes no quantity", () => {
  const fn = code(fnBody(STAFF, "staffSetVariantAvailability"));
  assert.ok(/setVariantAvailabilityState\(/.test(fn), "calls the engine");
  assert.equal(/stock_quantity\s*:/.test(fn), false, "no variant quantity write (select is read-only)");
});

// ── parent & variant availability are separate ───────────────────────────────

test("engine keeps product and variant writers on their own tables", () => {
  assert.ok(/writeProductAvailability[\s\S]*\.from\(["']products["']\)/.test(ENGINE), "product writer → products");
  assert.ok(/writeVariantAvailability[\s\S]*\.from\(["']product_variants["']\)/.test(ENGINE), "variant writer → product_variants");
});

// ── Talabat honors explicit variant availability (not quantity) ──────────────

test("Talabat export reads explicit variant availability via the read-model", () => {
  const c = code(read("lib/talabat/export.ts"));
  assert.ok(/normalizeAvailability\(v\.stock_status\)/.test(c), "variant availability from explicit stock_status");
  assert.equal(/v\.stock_quantity\s*<=\s*0/.test(c), false, "no variant-quantity OOS derivation");
});

// ── Shopify stays non-destructive and product-level (no per-variant behavior) ─

test("Shopify sync introduces no per-variant availability behavior", () => {
  const c = code(read("lib/shopify/inventory-sync.ts"));
  assert.equal(/product_variants[\s\S]{0,40}stock_status/.test(c), false, "no variant stock_status use in the Shopify push");
  assert.equal(/\.from\(["']product_variants["']\)\s*\.update/.test(c), false, "no variant write");
});

// ── read-model never infers availability from quantity ───────────────────────

test("read-model has no quantity reference (NULL/unknown stays explicit)", () => {
  const c = code(read("lib/availability/read.ts"));
  assert.equal(/stock_quantity/.test(c), false, "availability never derived from quantity");
});

// ── migration is additive + reversible, and does NOT backfill from quantity ──

test("variant_stock_status.sql is additive, reversible, and backfill-free", () => {
  const sql = read("supabase/variant_stock_status.sql");
  // Reversal is documented in a comment; column mentions in prose are fine. The
  // executable STATEMENTS (comments stripped) are what must stay additive.
  const stmts = sql.replace(/--[^\n]*/g, "");
  assert.ok(/ADD COLUMN IF NOT EXISTS\s+stock_status\s+text/i.test(stmts), "adds the column additively");
  assert.ok(/DROP COLUMN IF EXISTS\s+stock_status/i.test(sql), "documents the reverse (comment ok)");
  assert.equal(/UPDATE\s+product_variants/i.test(stmts), false, "no backfill/UPDATE statement");
  assert.equal(/stock_quantity/i.test(stmts), false, "no quantity reference in executable SQL");
});
