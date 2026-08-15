// CH.5 — durable identity guard (source scan + invariants).
//
// Proves (§14):
//   1. the pure CH.5 identity modules stay pure;
//   2. adapters access identity through ExternalIdentityResolver — never by
//      reading external_channel_listings directly;
//   3. NO new channel-specific product-ID column is introduced (products is not
//      altered by the CH.5 migration);
//   4. multi-store identity is preserved (Snoonu owns two storefronts);
//   5. Snoonu SPI is storefront-scoped;
//   6. Talabat mappings are variant-capable;
//   7. NO channel/store/listing inventory source is introduced (no stock column,
//      no quantity field anywhere in the CH.5 identity layer).
//
// node --conditions=react-server --experimental-strip-types --test lib/channels/ch5-identity-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { storefrontsForChannel } from "./storefronts.ts";
import { externalIdentityKey, storefrontGrain } from "./external-listing-identity.ts";
import { createDurableIdentityResolver } from "./durable-identity-resolver.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const PURE_CH5 = [
  "lib/channels/storefronts.ts",
  "lib/channels/external-listing-identity.ts",
  "lib/channels/external-listing-backfill.ts",
  "lib/channels/durable-identity-resolver.ts",
];
const MIGRATION = "supabase/migrations/20260816130000_ch5_external_channel_listings.sql";

test("1. pure CH.5 identity modules stay pure (no @/ imports, no server-only)", () => {
  for (const f of PURE_CH5) {
    const src = read(f);
    assert.equal(/from\s+["']@\//.test(src), false, `${f} pure`);
    assert.equal(/import\s+["']server-only["']/.test(src), false, `${f} not server-only`);
  }
});

test("2. adapters access identity via ExternalIdentityResolver, not the table", () => {
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const n of readdirSync(join(ROOT, dir))) {
      const rel = join(dir, n);
      if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
      // Adapter FACTORIES only — exclude tests and server READERS (*.server.ts),
      // which are the concrete server layer and may read the identity table.
      else if (/\.tsx?$/.test(rel) && !/\.test\.tsx?$/.test(rel) && !/\.server\.tsx?$/.test(rel)) out.push(rel);
    }
    return out;
  };
  for (const f of walk("lib/adapters")) {
    assert.equal(/external_channel_listings/.test(read(f)), false, `${f} (adapter factory) must not read the identity table directly`);
  }
  // The durable resolver structurally implements the CH.4 interface.
  const r = createDurableIdentityResolver({ byProduct: async () => [], byExternalId: async () => [], bySku: async () => [] });
  assert.equal(typeof r.resolve, "function");
  assert.equal(typeof r.resolveExternalListing, "function");
  assert.equal(typeof r.resolveInternalListing, "function");
});

test("3. the CH.5 migration introduces NO new channel-specific product-ID column", () => {
  const sql = read(MIGRATION);
  assert.equal(/ALTER\s+TABLE\s+public\.products/i.test(sql), false, "products table is not altered");
  assert.equal(/ADD\s+COLUMN[^;]*_id\b/i.test(sql.replace(/external_channel_listings/g, "")), false, "no new *_id column added to existing tables");
});

test("4. multi-store identity preserved: Snoonu owns two storefronts", () => {
  assert.equal(storefrontsForChannel("snoonu").length, 2);
});

test("5. Snoonu SPI is storefront-scoped (same value, different store ⇒ different identity)", () => {
  const a = externalIdentityKey({ storefrontKey: "snoonu:malikas", externalProductId: "SPI", externalVariantId: null });
  const b = externalIdentityKey({ storefrontKey: "snoonu:pure_seoul", externalProductId: "SPI", externalVariantId: null });
  assert.notEqual(a, b);
});

test("6. Talabat mappings are variant-capable", () => {
  assert.equal(storefrontGrain("talabat:malikas"), "variant");
});

test("7. NO inventory source: no stock/quantity column or field in the CH.5 identity layer", () => {
  // migration: no stock/quantity column
  const sql = read(MIGRATION);
  assert.equal(/\b(stock|quantity|qty)\b/i.test(sql.replace(/[^\n]*--[^\n]*/g, "")), false, "no stock/quantity column in the table DDL");
  // pure modules: no quantity fields
  for (const f of PURE_CH5) {
    const src = read(f).replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    assert.equal(/\b(channelStock|channel_stock|stockQuantity|quantity|inventoryQuantity)\b/.test(src), false, `${f} owns no quantity`);
  }
});
