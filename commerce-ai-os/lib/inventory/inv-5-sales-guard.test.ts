// INV.5 — unified sales engine source guard.
//
// Pins the TypeScript side of the Shopify/Talabat symmetry:
//   * the Engine sell() is a REAL wrapper (removed from NOT_IMPLEMENTED_OPS);
//   * the Shopify AND Talabat sale paths go through a canonical RPC (no direct
//     numeric inventory write in the TS channel paths);
//   * no products mirror write, no stock_status write, no totalStock dependency
//     on the sale/transition paths;
//   * channel audits are guarded immutable (movements + approvals);
//   * the OUTBOUND Shopify availability push policy is untouched.
//
// PURE — source scan only. Run:
// node --conditions=react-server --experimental-strip-types --test lib/inventory/inv-5-sales-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const ENGINE = read("lib/inventory/engine.ts");
const LEDGER = strip(read("lib/shopify/order-ledger.ts"));
const SYNC = strip(read("lib/shopify/inventory-sync.ts"));
const TALABAT = strip(read("lib/talabat/process-order.ts"));

const anyNumericWrite = (src: string) =>
  /\.from\(\s*["'](inventory|product_variants|shelf_stock|variant_shelf_stock)["']\s*\)\s*\.(update|insert|upsert|delete)/.test(src);
const productsMirrorWrite = (src: string) =>
  /\.from\(\s*["']products["']\s*\)\s*\.(update|insert|upsert)\(\s*\{[^}]*stock_quantity/.test(src);

// ── engine sell() is real ─────────────────────────────────────────────────────

test("engine: sell is implemented and removed from NOT_IMPLEMENTED_OPS", () => {
  assert.ok(/export async function sell\(/.test(ENGINE), "sell is a real async wrapper");
  assert.ok(/rpc\("inv_sell"/.test(ENGINE), "sell calls the inv_sell RPC");
  assert.equal(/"sell",/.test(ENGINE.replace(/export async function sell[\s\S]*/, "")), false,
    "sell no longer listed in NOT_IMPLEMENTED_OPS");
  assert.equal(/export const sell = \(\.\.\._args/.test(ENGINE), false, "the throwing sell stub is gone");
});

// ── Shopify sale path: canonical RPC, no direct writes, no mirror/availability ─

test("Shopify order-ledger drives the canonical RPC only, no direct numeric write", () => {
  assert.equal(anyNumericWrite(LEDGER), false, "no direct numeric inventory write in the ledger");
  assert.equal(productsMirrorWrite(LEDGER), false, "no products mirror write");
  // grain-aware payload (productId/variantId), not the legacy product_id-only shape
  assert.ok(/productId: d\.productId, variantId: d\.variantId/.test(LEDGER), "p_deductions carry the durable grain");
});

test("Shopify inventory-sync calls process_shopify_order_deduction + authoritative transitions", () => {
  assert.ok(/rpc\("process_shopify_order_deduction"/.test(SYNC), "sale via the canonical order RPC");
  assert.equal(anyNumericWrite(SYNC), false, "no direct numeric inventory write on the sync path");
  assert.ok(/logAuthoritativeStockTransition/.test(SYNC), "authoritative product transition");
  assert.ok(/logAuthoritativeVariantOnlyTransition/.test(SYNC), "variant-only transition");
  assert.equal(/logStockTransition\(/.test(SYNC), false, "legacy logStockTransition retired on this path");
  assert.equal(/totalStock/.test(SYNC), false, "no totalStock dependency");
  assert.equal(productsMirrorWrite(SYNC), false, "no products mirror write");
});

test("Shopify OUTBOUND availability push policy is untouched (OOS→0 only)", () => {
  assert.ok(/shopifyOosZeroPushList/.test(SYNC), "still uses the availability OOS→0 push list");
});

// ── Talabat sale path: same processor, transitions, no direct write ───────────

test("Talabat processor uses the order RPC + best-effort transitions, no direct numeric write", () => {
  assert.ok(/rpc\("process_talabat_order_deduction"/.test(TALABAT), "sale via the canonical order RPC");
  assert.equal(anyNumericWrite(TALABAT), false, "processor performs no direct numeric write");
  assert.ok(/logTransitions/.test(TALABAT), "best-effort transition port is invoked on processed");
  assert.equal(/totalStock/.test(TALABAT), false, "no totalStock dependency");
});

// ── channel audit immutability guard wired in the manual endpoints ────────────

test("movements + approvals guard channel sale audits as immutable", () => {
  assert.ok(/export function isChannelSaleAudit/.test(read("lib/inventory/channel-immutability.ts")), "pure guard helper exists");
  const mv = read("lib/inventory/movements.ts");
  assert.ok(/isChannelSaleAudit\(row\)/.test(mv), "editMovementQty / deleteMovement consult the guard");
  assert.ok(/CHANNEL_SALE_LOCKED_MSG/.test(mv), "movement endpoints return the fixed locked message");
  const appr = read("app/(app)/inventory/approvals-actions.ts");
  assert.ok(/isChannelSaleAudit\(row\)/.test(appr), "reverseMovement / approveMovements consult the guard");
});

// ── movements.ts numeric engine stays legacy-direct (NOT migrated in INV.5) ────

test("movements.ts numeric movement engine remains legacy-direct (untouched by INV.5)", () => {
  const mv = strip(read("lib/inventory/movements.ts"));
  assert.ok(anyNumericWrite(mv), "applyMovement/editMovementQty still do their direct RMW (reversal is a later phase)");
});
