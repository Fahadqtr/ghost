// INT.2G — Legacy Shopify publish retirement guard (source scan).
//
// Proves there is EXACTLY ONE Shopify product-publish boundary in the whole
// platform — the certified Export Center flow — and that the legacy create path
// (pushProductsToShopify, wired as the dormant CH.4 adapter's publish) is retired
// at the code level so no UI, action, or adapter can create products through it.
//
// The single certified boundary:
//   /v2/export/shopify:malikas → /api/export/shopify/publish
//     → lib/export/shopify/publish.server.ts (ECL identity + row fingerprint +
//        staleness guard + export_runs audit).
//
// PURE — source scan only. Run:
// node --conditions=react-server --experimental-strip-types --test lib/export/int2g-publish-retirement-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const exists = (rel: string) => existsSync(join(ROOT, rel));
// strip block + line comments so a mention in a comment never counts as a call.
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const SHOPIFY_ACTIONS = "app/(app)/import-export/shopify-actions.ts";
const ADAPTER = "app/(app)/import-export/shopify-adapter.server.ts";
const SHOPIFY_SYNC = "components/ShopifySync.tsx";
const PUBLISH_SERVER = "lib/export/shopify/publish.server.ts";
const PUBLISH_ROUTE = "app/api/export/shopify/publish/route.ts";
const ADMIN = "lib/shopify/admin.ts"; // owns the createShopifyProduct primitive
const EXPORT_CENTER = "/v2/export/shopify:malikas";

/** Slice a single `export async function NAME(` body up to the next top-level export. */
function fnBody(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}(`);
  assert.notEqual(start, -1, `function ${name} not found`);
  const rest = src.slice(start + 1);
  const next = rest.indexOf("\nexport ");
  return next === -1 ? src.slice(start) : src.slice(start, start + 1 + next);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, name);
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
    else if (/\.tsx?$/.test(rel)) out.push(rel);
  }
  return out;
}

// ── 1. exactly ONE file CALLS createShopifyProduct — the certified publisher ───
test("createShopifyProduct has exactly one caller: the certified publish.server", () => {
  const callers: string[] = [];
  for (const f of [...walk("app"), ...walk("lib")]) {
    if (/\.test\.tsx?$/.test(f)) continue; // tests may reference the name
    if (f === ADMIN) continue;             // the module that DEFINES the primitive
    const s = strip(read(f));
    if (/\bcreateShopifyProduct\s*\(/.test(s)) callers.push(f);
  }
  assert.deepEqual(callers, [PUBLISH_SERVER], `only publish.server may create products on Shopify (found: ${callers.join(", ")})`);
});

// ── 2. the legacy pushProductsToShopify is a writer-gated no-op (retired) ──────
test("pushProductsToShopify is retired: writer-gated, no product creation, no side effect", () => {
  const src = read(SHOPIFY_ACTIONS);
  const body = fnBody(src, "pushProductsToShopify");
  const s = strip(body);
  // still authorization-gated (no downgrade of the security boundary)
  assert.ok(/requireMalakWriter\s*\(/.test(s), "keeps the writer gate");
  // creates nothing and performs no DB / store side effect
  assert.equal(/createShopifyProduct/.test(s), false, "no product creation");
  for (const se of [/\.from\(/, /\.insert\(/, /\.update\(/, /\.upsert\(/, /\.delete\(/, /\.rpc\(/, /fetchAllShopifyProducts/, /createAdminClient/]) {
    assert.equal(se.test(s), false, `retired body performs no side effect (${se})`);
  }
  // points the operator at the single certified publish flow
  assert.ok(body.includes(EXPORT_CENTER), "returns the Export Center deep-link");
  // and the file no longer imports the create/location primitives it needed
  assert.equal(/\bcreateShopifyProduct\b/.test(strip(src)), false, "shopify-actions no longer references createShopifyProduct");
  assert.equal(/\bfetchPrimaryLocationId\b/.test(strip(src)), false, "shopify-actions no longer references fetchPrimaryLocationId");
});

// ── 3. the dormant CH.4 adapter no longer wires the legacy create path ────────
test("the Shopify adapter publish is retired (no legacy create path)", () => {
  const s = strip(read(ADAPTER));
  assert.equal(/pushProductsToShopify/.test(s), false, "adapter no longer imports/wires pushProductsToShopify");
  assert.equal(/createShopifyProduct/.test(s), false, "adapter never creates products");
  // publish is still declared (contract conformance) but refuses
  assert.ok(/publish:\s*async/.test(s), "publish remains declared for contract conformance");
});

// ── 4. the certified publish boundary is intact and canonical ─────────────────
test("the certified Export Center publish boundary is intact", () => {
  assert.ok(exists(PUBLISH_SERVER), "publish.server exists");
  assert.ok(exists(PUBLISH_ROUTE), "publish route exists");
  const server = strip(read(PUBLISH_SERVER));
  assert.ok(/\bcreateShopifyProduct\s*\(/.test(server), "publish.server is the create boundary");
  // it stays identity-safe + audited (unchanged by INT.2G — asserted defensively)
  const raw = read(PUBLISH_SERVER);
  assert.ok(/export_runs/.test(raw), "records an export_runs audit row");
  const route = read(PUBLISH_ROUTE);
  assert.ok(/requireMalakWriter/.test(route), "publish route is writer-gated");
});

// ── 5. no UI executes legacy publish; the sync tool points to the Export Center ─
test("ShopifySync does not execute legacy publish and links to the Export Center", () => {
  const s = read(SHOPIFY_SYNC);
  assert.equal(/pushProductsToShopify/.test(s), false, "ShopifySync never calls the legacy publish");
  assert.ok(s.includes(EXPORT_CENTER), "ShopifySync points operators to the certified publisher");
});

// ── 6. INT.2G introduces no new write boundary / permission / secret ──────────
test("INT.2G adds no new secret, permission, or DDL to the touched files", () => {
  for (const f of [SHOPIFY_ACTIONS, ADAPTER]) {
    const s = strip(read(f));
    assert.equal(/apply_migration/i.test(s), false, `${f} runs no migration`);
    assert.equal(/\.rpc\(\s*["'`]?(create|alter|drop)\s+/i.test(s), false, `${f} executes no DDL via rpc`);
  }
  // the retired stub reads no new environment secret
  const body = strip(fnBody(read(SHOPIFY_ACTIONS), "pushProductsToShopify"));
  assert.equal(/process\.env/.test(body), false, "retired stub reads no env secret");
});
