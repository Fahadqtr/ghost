// INV.2D — source guards for channel availability propagation.
//
// Proves (by static source scan) that every channel-facing path honors the
// EXPLICIT product availability (products.stock_status) and never mutates a local
// quantity to represent it.
//
// PURE — source scan only. Run:
// node --conditions=react-server --experimental-strip-types --test lib/availability/propagation-guard.test.ts

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

const AVAIL_SYNC = read("lib/availability-sync.ts");
const CRON = read("app/api/cron/availability-sync/route.ts");
const INV_SYNC = read("lib/shopify/inventory-sync.ts");
const TALABAT = read("lib/talabat/export.ts");
const INV_ACTIONS = read("app/(app)/inventory/actions.ts");

// ── projection: products.stock_status → platform_status.availability ──────────

test("availability-sync projects from explicit stock_status via the read-model, never quantity", () => {
  const c = code(AVAIL_SYNC);
  assert.ok(/import \{ isAvailable \} from "\.\/availability\/read/.test(c), "imports the read-model");
  assert.ok(/export function projectAvailability\(/.test(c), "exposes projectAvailability");
  assert.equal(/computeStockStatus/.test(c), false, "quantity-based computeStockStatus removed");
  assert.equal(/stock_quantity/.test(c), false, "no quantity referenced in the projection core");
});

test("cron reads products.stock_status and projects it; no quantity-derived availability", () => {
  const c = code(CRON);
  assert.ok(/projectAvailability\(/.test(c), "cron uses projectAvailability");
  assert.ok(/from\("products"\)\.select\("id, stock_status"\)/.test(c), "cron reads products.stock_status");
  assert.equal(/computeStockStatus/.test(c), false, "no computeStockStatus");
  assert.equal(/\.from\("inventory"\)|\.from\("product_variants"\)/.test(c), false, "cron derives availability from neither inventory nor variants");
});

// ── Shopify: non-destructive, availability-driven, OOS → 0 ───────────────────

test("Shopify sync builds its push list from availability and writes NO local quantity", () => {
  const c = code(INV_SYNC);
  assert.ok(/shopifyOosZeroPushList\(/.test(c), "uses the OOS→0 push-list helper");
  assert.ok(/select\("id, sku, name_en, stock_status"\)/.test(c), "reads products.stock_status");
  assert.equal(/\.from\("inventory"\)\s*\.update/.test(c), false, "no inventory quantity write");
  assert.equal(/\.from\("product_variants"\)\s*\.update/.test(c), false, "no variant quantity write");
  assert.equal(/stock\.set\(|stock\.get\(/.test(c), false, "no quantity summation for the push");
});

// ── Talabat: export honors explicit availability, not variant quantity ───────

test("Talabat export reads the availability helper and drops the quantity derivation", () => {
  const c = code(TALABAT);
  assert.ok(/from "\.\.\/availability\/read/.test(c), "imports the availability read-model");
  assert.ok(/isAvailable\(p\.stock_status\)/.test(c), "availability from product stock_status");
  assert.equal(/stockNum/.test(c), false, "old quantity variable removed");
  assert.equal(/stock_quantity\s*<=\s*0/.test(c), false, "no quantity-based OOS derivation remains");
});

// ── OOS signal paths: no local quantity destruction; listing stays separate ──

test("markOutOfStockByNames marks availability via the engine and zeroes NO local quantity", () => {
  const fn = code(fnBody(INV_ACTIONS, "markOutOfStockByNames"));
  assert.ok(fn.length > 0, "located markOutOfStockByNames");
  assert.ok(/writeProductAvailability\(/.test(fn), "routes availability through the engine");
  assert.equal(/stock_quantity\s*:/.test(fn), false, "no stock_quantity write");
  assert.equal(/\.from\("inventory"\)\s*\.update/.test(fn), false, "no inventory zeroing");
  assert.equal(/\.from\("product_variants"\)\s*\.update/.test(fn), false, "no variant zeroing");
  assert.ok(/channel_status: "Not Listed"/.test(fn), "delist policy preserved (separate concern)");
  assert.ok(/pushStockToShopify\([\s\S]*quantity: 0/.test(fn), "still pushes Shopify 0 externally");
});

test("matchChannelsToMalika derives OOS from explicit availability and zeroes NO local quantity", () => {
  const fn = code(fnBody(INV_ACTIONS, "matchChannelsToMalika"));
  assert.ok(fn.length > 0, "located matchChannelsToMalika");
  assert.ok(/isAvailable\(/.test(fn), "OOS set from explicit availability");
  assert.equal(/stock_quantity\s*:/.test(fn), false, "no stock_quantity write");
  assert.equal(/\.from\("inventory"\)\s*\.update|\.from\("product_variants"\)\s*\.update/.test(fn), false, "no quantity writes");
  assert.ok(/channel_status: "Not Listed"/.test(fn), "delist policy preserved");
});

// ── channel_status stays a listing concern, not an availability source ───────

test("availability modules never read channel_status as an availability source", () => {
  for (const rel of ["lib/availability/read.ts", "lib/availability/engine.ts", "lib/availability-sync.ts", "lib/availability/channel-policy.ts"]) {
    const c = code(read(rel));
    assert.equal(/channel_status|channel_products/.test(c), false, `${rel} does not touch channel listing state`);
  }
});

// ── Snoonu / Pure Seoul / Rafeeq: no new outbound availability sync ──────────

test("no new outbound availability push exists for Snoonu / Pure Seoul / Rafeeq", () => {
  for (const rel of ["app/(app)/import-export/snoonu-actions.ts", "app/(app)/import-export/pure-seoul-actions.ts"]) {
    const c = code(read(rel));
    // These files may still upsert the internal platform_status projection, but
    // must not push availability out to the platform (no Shopify-style setter).
    assert.equal(/setInventoryQuantities|pushInventoryStockToShopify|shopifyOosZeroPushList/.test(c), false, `${rel} introduces no outbound availability push`);
  }
});

// ── quantity protection across the propagation modules ───────────────────────

test("QUANTITY PROTECTION: no propagation module writes a quantity/shelf/sold column", () => {
  for (const [rel, src] of [
    ["lib/availability-sync.ts", AVAIL_SYNC],
    ["lib/availability/channel-policy.ts", read("lib/availability/channel-policy.ts")],
    ["app/api/cron/availability-sync/route.ts", CRON],
  ] as const) {
    const c = code(src);
    for (const re of [/stock_quantity\s*:/, /sold_quantity\s*:/, /\.from\("(shelf_stock|variant_shelf_stock)"\)/]) {
      assert.equal(re.test(c), false, `${rel} writes no quantity/shelf/sold column`);
    }
  }
});
