// CH.4 — Channel Adapter framework guard (source scan + conformance).
//
// Pins the framework's invariants so later adapters (Talabat/Snoonu/Rafeeq) and
// edits can't erode them:
//   1. the lib/adapters framework is PURE (no @/ imports, no server-only);
//   2. it adds NO storage — no DB client, write verb, RPC, or DDL anywhere;
//   3. it does NOT reach into inventory / security / service-role modules;
//   4. the Shopify adapter conforms to the full ChannelAdapter contract;
//   5. store-awareness holds (>= 1 store, each with listingGrain + unique key);
//   6. the concrete server wiring is server-only AND uncalled (no behavior change).
//
// node --conditions=react-server --experimental-strip-types --test lib/adapters/ch4-adapter-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createShopifyAdapter, type ShopifyAdapterDeps } from "./shopify/shopify-adapter.ts";
import { SHOPIFY_STORES } from "./shopify/store.ts";
import { CAPABILITY_METHODS, type ChannelAdapter } from "./types.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, name);
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
    else if (/\.ts$/.test(rel)) out.push(rel);
  }
  return out;
}

const FRAMEWORK = walk("lib/adapters").filter((f) => !/\.test\.ts$/.test(f));

test("1. the lib/adapters framework is PURE (no @/ imports, no server-only)", () => {
  for (const f of FRAMEWORK) {
    const src = read(f);
    assert.equal(/from\s+["']@\//.test(src), false, `${f} must not use @/ imports`);
    assert.equal(/import\s+["']server-only["']/.test(src), false, `${f} must not import server-only`);
    assert.equal(/from\s+["'](react|next)/.test(src), false, `${f} must not import react/next`);
  }
});

test("2. the framework adds NO storage — no DB client, write verb, RPC, or DDL", () => {
  const forbidden = [
    /createAdminClient/, /createClient\(/, /\.insert\(/, /\.update\(/, /\.delete\(/,
    /\.upsert\(/, /\.rpc\(/, /create\s+table/i, /alter\s+table/i,
  ];
  for (const f of FRAMEWORK) {
    const src = read(f);
    for (const re of forbidden) {
      assert.equal(re.test(src), false, `${f} must not contain ${re} (framework creates no storage)`);
    }
  }
});

test("3. the framework does NOT reach into inventory / security / service-role", () => {
  const forbidden = [/lib\/inventory/, /malak\/authz/, /requireMalakWriter/, /supabase\/admin/, /lib\/availability/];
  for (const f of FRAMEWORK) {
    const src = read(f);
    for (const re of forbidden) {
      assert.equal(re.test(src), false, `${f} must not depend on ${re}`);
    }
  }
});

test("4. the Shopify adapter conforms to the full ChannelAdapter contract", () => {
  const noopDeps: ShopifyAdapterDeps = {
    resolver: { resolve: async (s) => ({ storeKey: s.storeKey, externalListingId: null, source: "none" }) },
    listListings: async () => ({ products: [] }),
    syncCatalog: async () => ({ ok: true, updated: 0, failed: [] }),
    syncImages: async () => ({ ok: true, updated: 0, failed: [] }),
    syncAvailability: async () => ({ ok: true, matched: 0, updated: 0 }),
    syncPrices: async () => ({ ok: true, updated: 0, failed: [] }),
    publish: async () => ({ ok: true, created: 0, skipped: 0, failed: [] }),
    unpublish: async () => ({ ok: true, updated: 0, failed: [] }),
    ingestOrders: async () => ({ ok: true, ingested: 0, skipped: 0 }),
  };
  const a: ChannelAdapter = createShopifyAdapter(noopDeps);
  for (const method of Object.values(CAPABILITY_METHODS)) {
    assert.equal(typeof (a as unknown as Record<string, unknown>)[method], "function", `implements ${method}()`);
  }
  assert.equal(typeof a.resolveListing, "function");
  assert.equal(typeof a.stores, "function");
});

test("5. store-awareness: >= 1 store, each with listingGrain + a unique storeKey", () => {
  assert.ok(SHOPIFY_STORES.length >= 1);
  const keys = new Set<string>();
  for (const s of SHOPIFY_STORES) {
    assert.ok(["product", "variant"].includes(s.listingGrain), "listingGrain set");
    assert.equal(s.channel, "shopify");
    assert.equal(keys.has(s.storeKey), false, "storeKey unique");
    keys.add(s.storeKey);
  }
});

test("6. the concrete server wiring is server-only AND uncalled (no behavior change)", () => {
  const wiring = "app/(app)/import-export/shopify-adapter.server.ts";
  assert.ok(/import\s+["']server-only["']/.test(read(wiring)), "server wiring is server-only");
  // Nothing in app/ or lib/ imports the wiring module → it is dead code → no
  // production behavior change from CH.4.
  const importers: string[] = [];
  for (const f of [...walk("lib"), ...walk("app")]) {
    if (f.endsWith("shopify-adapter.server.ts") || f.endsWith(".test.ts")) continue;
    if (/shopify-adapter\.server/.test(read(f))) importers.push(f);
  }
  assert.deepEqual(importers, [], `nothing may import the wiring yet: ${importers.join(", ")}`);
});
