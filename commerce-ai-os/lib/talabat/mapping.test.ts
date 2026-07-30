// Tests for the Talabat variant-mapping foundation. Pure — NO Supabase, NO
// network. Behaviour tests import the pure module; migration guarantees are
// verified by scanning the SQL files as text.
// Run: node --conditions=react-server --experimental-strip-types --test lib/talabat/mapping.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  normalizeChannelProductId,
  normalizeExportedSku,
  normalizeBarcode,
  normalizeMasterVariantSku,
  buildMappingIdentity,
  isMappingConfirmed,
  validateMappingCandidate,
  classifyMappingStatus,
  type MappingCandidate,
} from "./mapping.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const CVM = read("supabase/channel_variant_mappings.sql");
const DEDUP = read("supabase/talabat_orders_dedup.sql");
// SQL with line comments removed, for "must not contain" scans (so a word in a
// comment can't trip an absence check).
const stripSql = (s: string) => s.replace(/--.*$/gm, "");
const CVM_CODE = stripSql(CVM);
const DEDUP_CODE = stripSql(DEDUP);

function candidate(over: Partial<MappingCandidate>): MappingCandidate {
  return {
    channelId: "chan-talabat",
    masterProductId: "prod-1",
    masterVariantSku: null,
    exportedSku: "mk100",
    exportedBarcode: "6291000000017",
    channelProductId: null,
    ...over,
  };
}

// ---- Module behaviour -------------------------------------------------------

test("1: a no-variant product maps with masterVariantSku = null", () => {
  const id = buildMappingIdentity(candidate({ masterVariantSku: null, exportedSku: "mk100" }));
  assert.equal(id.masterVariantSku, null);
  assert.equal(validateMappingCandidate(candidate({ masterVariantSku: null })).ok, true);
});

test("2: a variant mapping is keyed on the variant SKU", () => {
  const id = buildMappingIdentity(candidate({ masterVariantSku: "mk100-1", exportedSku: "mk100-1" }));
  assert.equal(id.masterVariantSku, "mk100-1");
  assert.deepEqual(id, { channelId: "chan-talabat", masterProductId: "prod-1", masterVariantSku: "mk100-1" });
});

test("3: no variant id exists in the identity or the durable type", () => {
  const id = buildMappingIdentity(candidate({ masterVariantSku: "mk100-1" }));
  const keys = Object.keys(id);
  assert.deepEqual(keys.sort(), ["channelId", "masterProductId", "masterVariantSku"]);
  assert.ok(!keys.some((k) => /variant_?id/i.test(k)), "identity must not carry a variant id");
  // The candidate shape itself has no variantId field.
  assert.ok(!("variantId" in candidate({})), "candidate must not carry a variant id");
});

test("4: an empty exported SKU is rejected", () => {
  assert.equal(normalizeExportedSku("   "), "");
  const v = validateMappingCandidate(candidate({ exportedSku: "  " }));
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /exportedSku/.test(e)));
});

test("5: an empty channelProductId is not a confirmed mapping", () => {
  assert.equal(normalizeChannelProductId(""), null);
  assert.equal(normalizeChannelProductId("  "), null);
  assert.equal(isMappingConfirmed(candidate({ channelProductId: null })), false);
  assert.equal(isMappingConfirmed(candidate({ channelProductId: "  " })), false);
  assert.equal(isMappingConfirmed(candidate({ channelProductId: "TLB-99" })), true);
  assert.equal(validateMappingCandidate(candidate({ channelProductId: "" })).confirmed, false);
});

test("6: a barcode is cleaned without inventing a value", () => {
  assert.equal(normalizeBarcode("  6291 0000 000 17 "), "6291000000017"); // spaces stripped only
  assert.equal(normalizeBarcode(""), null);
  assert.equal(normalizeBarcode(null), null);
  assert.equal(normalizeBarcode(undefined), null); // never fabricates a barcode
  assert.equal(normalizeMasterVariantSku("  "), null);
});

test("7: a complete, valid mapping is classified active", () => {
  assert.equal(classifyMappingStatus(candidate({ masterVariantSku: "mk100-1", exportedBarcode: "6291000000017" })), "active");
  assert.equal(classifyMappingStatus(candidate({ masterVariantSku: null })), "active"); // channelProductId null is fine
});

test("8: an incomplete mapping is classified needs_review", () => {
  assert.equal(classifyMappingStatus(candidate({ exportedSku: "" })), "needs_review");        // invalid identity
  assert.equal(classifyMappingStatus(candidate({ exportedBarcode: null })), "needs_review");  // missing barcode
  assert.equal(classifyMappingStatus(candidate({ masterVariantSku: "  " })), "needs_review"); // blank variant sku
});

test("9: an archived product/variant is classified archived", () => {
  assert.equal(classifyMappingStatus(candidate({ archived: true })), "archived");
  // archived wins even when other fields are missing.
  assert.equal(classifyMappingStatus(candidate({ archived: true, exportedSku: "", exportedBarcode: null })), "archived");
});

// ---- Migration guarantees (text scan) --------------------------------------

test("10: channel_variant_mappings has a UNIQUE on (channel, exported_sku)", () => {
  assert.match(CVM, /create unique index[^;]*channel_variant_mappings[^;]*\(channel_id, exported_sku\)/is);
});

test("11: channel_variant_mappings has a PARTIAL UNIQUE on (channel, channel_product_id)", () => {
  assert.match(
    CVM,
    /create unique index[^;]*\(channel_id, channel_product_id\)\s*where channel_product_id is not null/is,
  );
});

test("11b: there is a durable identity UNIQUE on (channel, product, variant sku)", () => {
  assert.match(
    CVM,
    /create unique index[^;]*\(channel_id, master_product_id, coalesce\(master_variant_sku, ''\)\)/is,
  );
});

test("12: no channel_stock column is added", () => {
  assert.ok(!/channel_stock/i.test(CVM_CODE), "channel_variant_mappings must not define channel_stock");
  assert.ok(!/channel_stock/i.test(DEDUP_CODE));
});

test("12b: the durable key stores the variant SKU, never product_variants.id", () => {
  assert.match(CVM_CODE, /master_variant_sku/);
  assert.ok(!/variant_id/i.test(CVM_CODE), "must not store a variant_id");
});

test("13: the talabat_orders migration adds dedup_key, processed_at, resolution (+ processing_status)", () => {
  for (const col of ["dedup_key", "processing_status", "processed_at", "resolution"]) {
    assert.match(DEDUP, new RegExp(`add column if not exists\\s+${col}\\b`, "i"), `adds ${col}`);
  }
  assert.match(DEDUP, /create unique index[^;]*talabat_orders[^;]*\(dedup_key\)\s*where dedup_key is not null/is);
});

test("14: migrations do not drop or rename any column/table", () => {
  for (const [name, sql] of [["channel_variant_mappings.sql", CVM_CODE], ["talabat_orders_dedup.sql", DEDUP_CODE]] as const) {
    assert.ok(!/drop\s+column/i.test(sql), `${name} must not drop a column`);
    assert.ok(!/rename\s+/i.test(sql), `${name} must not rename`);
    assert.ok(!/drop\s+table/i.test(sql), `${name} must not drop a table`);
  }
});

test("15: all migrations are idempotent", () => {
  assert.match(CVM, /create table if not exists/i);
  assert.match(CVM, /create unique index if not exists/i);
  assert.match(CVM, /drop policy if exists/i);           // guarded before create policy
  assert.match(DEDUP, /add column if not exists/i);
  assert.match(DEDUP, /create unique index if not exists/i);
  assert.match(DEDUP, /if not exists \(\s*select 1 from pg_constraint/is); // guarded constraint
});

test("16: the mapping module is pure — no network/Supabase usage", () => {
  // Strip comments so the module's own docstring (which mentions "no Supabase")
  // can't trip these checks; assert on real imports/usage only.
  const src = read("lib/talabat/mapping.ts").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!/\bimport\b[^\n]*supabase/i.test(src), "mapping.ts must not import supabase");
  assert.ok(!/createClient|createAdminClient/.test(src), "mapping.ts must not create a DB client");
  assert.ok(!/\.from\(/.test(src), "mapping.ts must not run a DB query");
  assert.ok(!/\bfetch\(/.test(src), "mapping.ts must not call fetch");
  assert.ok(!/from ["']server-only["']/.test(src), "mapping.ts must not import server-only");
  assert.ok(!/https?:\/\//.test(src), "mapping.ts must not contain a network URL");
});
