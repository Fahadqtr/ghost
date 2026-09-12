// CHANNEL IDENTITY — owner proofs for the exported_sku contract repair.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { resolveEffectiveSku, identityIndexKey, buildChannelIdentityIndex } from "./effective-sku.ts";

const code = (rel: string): string =>
  readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const RAFEEQ = "../export/rafeeq/preview.server.ts";
const SNOONU = "../export/snoonu/preview.server.ts";
const TALABAT = "../export/talabat/preview.server.ts";
const SHOPIFY = "../export/shopify/preview.server.ts";

const row = (o: Record<string, unknown>) => ({ storefront_key: "rafeeq:malikas", ...o });
const ev = (_r: Record<string, unknown>, x: { sku: string; contested: boolean }) => x;

// ── the rule itself ──────────────────────────────────────────────────────────
test("1 · exported_sku present → it is used", () => {
  const r = resolveEffectiveSku("mk900", "mk900");
  assert.deepEqual(r, { ok: true, sku: "mk900", source: "exported" });
});

test("2 · exported_sku NULL → canonical SKU fallback", () => {
  assert.deepEqual(resolveEffectiveSku(null, "mk900"), { ok: true, sku: "mk900", source: "canonical" });
});

test("3 · exported_sku empty string / whitespace → canonical fallback", () => {
  assert.deepEqual(resolveEffectiveSku("", "mk900"), { ok: true, sku: "mk900", source: "canonical" });
  assert.deepEqual(resolveEffectiveSku("   ", "mk900"), { ok: true, sku: "mk900", source: "canonical" });
  assert.deepEqual(resolveEffectiveSku(undefined, "mk900"), { ok: true, sku: "mk900", source: "canonical" });
});

test("4 · both present and equal → accepted, case-insensitively", () => {
  assert.equal(resolveEffectiveSku("mk900", "mk900").ok, true);
  const mixed = resolveEffectiveSku("MK900", "mk900");
  assert.equal(mixed.ok, true, "case alone is the same identity — matching has always been lower()");
  assert.equal(mixed.ok && mixed.sku, "MK900", "the value keeps its own case");
  assert.equal(resolveEffectiveSku(" mk900 ", "mk900").ok, true, "surrounding whitespace is trimmed");
});

test("5 · both present and different → explicit conflict, never silently chosen", () => {
  const r = resolveEffectiveSku("mk898", "mk900");
  assert.deepEqual(r, { ok: false, reason: "conflict", exportedSku: "mk898", canonicalSku: "mk900" });
});

test("6 · neither present → blocked, nothing invented", () => {
  assert.deepEqual(resolveEffectiveSku(null, null), { ok: false, reason: "no_identity", exportedSku: null, canonicalSku: null });
  assert.deepEqual(resolveEffectiveSku("", "  "), { ok: false, reason: "no_identity", exportedSku: null, canonicalSku: null });
});

test("7 · barcode is never a fallback — the rule has no barcode input at all", () => {
  const src = code("./effective-sku.ts");
  assert.ok(!/barcode\s*\)/.test(src) && !/row\.barcode|\.exported_barcode/.test(src), "no barcode is read");
  assert.equal(resolveEffectiveSku(null, null).ok, false, "a row without a SKU stays unidentified");
  for (const loader of [RAFEEQ, SNOONU, TALABAT]) {
    assert.ok(!/canonicalSkuForRow[\s\S]{0,220}barcode/.test(code(loader)), `${loader}: no barcode in the identity path`);
  }
});

// ── the shared index ─────────────────────────────────────────────────────────
test("8 · rows with an empty exported_sku are RECOVERED by the canonical SKU", () => {
  const out = buildChannelIdentityIndex({
    rows: [row({ product_id: "p1", exported_sku: null }), row({ product_id: "p2", exported_sku: "" })],
    storefrontKey: "rafeeq:malikas",
    canonicalSkuForRow: (r) => (r.product_id === "p1" ? "mk1" : "mk2"),
    toEvidence: ev,
  });
  assert.deepEqual(Object.keys(out.index).sort(), ["mk1", "mk2"]);
  assert.equal(out.stats.fromCanonical, 2);
  assert.equal(out.stats.fromExported, 0);
  assert.equal(out.stats.noIdentity, 0);
});

test("9 · a contested row is indexed under the CANONICAL sku and marked contested", () => {
  const out = buildChannelIdentityIndex({
    rows: [row({ product_id: "p1", exported_sku: "mk898" })],
    storefrontKey: "rafeeq:malikas",
    canonicalSkuForRow: () => "mk900",
    toEvidence: ev,
  });
  assert.deepEqual(out.conflicts, [{ productId: "p1", variantId: null, exportedSku: "mk898", canonicalSku: "mk900" }]);
  assert.equal(out.index["mk900"].contested, true, "found under what the catalogue says");
  assert.equal(out.index["mk898"], undefined, "never indexed under the disputed value");
  assert.equal(out.stats.conflicts, 1);
});

test("10 · storefront scope and product-grain filtering are enforced", () => {
  const rows = [
    row({ product_id: "p1", exported_sku: "a" }),
    { storefront_key: "snoonu:malikas", product_id: "p2", exported_sku: "b" },
    row({ product_id: "p3", variant_id: "v1", exported_sku: "c" }),
  ];
  const grain = buildChannelIdentityIndex({ rows, storefrontKey: "rafeeq:malikas", productGrainOnly: true,
    canonicalSkuForRow: () => null, toEvidence: ev });
  assert.deepEqual(Object.keys(grain.index), ["a"], "other storefronts and variant rows are out");
  const all = buildChannelIdentityIndex({ rows, storefrontKey: "rafeeq:malikas",
    canonicalSkuForRow: () => null, toEvidence: ev });
  assert.deepEqual(Object.keys(all.index).sort(), ["a", "c"], "without the flag, variant rows stay in");
});

test("11 · a variant row resolves against the VARIANT sku, never the parent's", () => {
  const byProduct = new Map([["p1", "mk995"]]);
  const byVariant = new Map([["v1", "mk995-3-white"]]);
  const out = buildChannelIdentityIndex({
    rows: [row({ product_id: "p1", variant_id: "v1", exported_sku: null })],
    storefrontKey: "rafeeq:malikas",
    canonicalSkuForRow: (r) => {
      const vid = typeof r.variant_id === "string" ? r.variant_id : null;
      return vid ? byVariant.get(vid) ?? null : byProduct.get(String(r.product_id)) ?? null;
    },
    toEvidence: ev,
  });
  assert.deepEqual(Object.keys(out.index), ["mk995-3-white"]);
  assert.equal(out.index["mk995"], undefined, "the parent identity is not borrowed");
  assert.equal(identityIndexKey("MK995-3-White"), "mk995-3-white");
});

// ── production-shaped regression proof ───────────────────────────────────────
test("12 · REGRESSION: 1339 Rafeeq bindings with NULL exported_sku stay visible", () => {
  // Production shape as measured on 2026-09-12: every rafeeq:malikas row has
  // exported_sku NULL, and 1339 of them carry a new-generation numeric id.
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < 1339; i++) {
    rows.push(row({ product_id: `p${i}`, exported_sku: null, external_product_id: String(698933171 + i), mapping_status: "active" }));
  }
  const out = buildChannelIdentityIndex<{ sku: string; externalId: string | null }>({
    rows, storefrontKey: "rafeeq:malikas", productGrainOnly: true,
    canonicalSkuForRow: (r) => `mk${String(r.product_id).slice(1)}`,
    toEvidence: (r, x) => ({ sku: x.sku, externalId: String(r.external_product_id) }),
  });
  assert.equal(Object.keys(out.index).length, 1339, "all 1339 are visible");
  assert.equal(out.stats.fromCanonical, 1339, "all recovered via the canonical SKU");
  assert.equal(out.stats.noIdentity, 0);
  assert.equal(out.conflicts.length, 0);
  // and every one carries its real Rafeeq id — so the packager cannot emit a blank product_id
  assert.equal(Object.values(out.index).filter((e) => e.externalId !== "null" && e.externalId !== "").length, 1339);
});

test("13 · the OLD behaviour would have indexed none of them", () => {
  const old = (rows: readonly Record<string, unknown>[]) => {
    const idx: Record<string, unknown> = {};
    for (const e of rows) {
      const sku = typeof e.exported_sku === "string" && e.exported_sku.trim() !== "" ? e.exported_sku : null;
      if (!sku) continue;
      idx[sku.toLowerCase()] = e;
    }
    return idx;
  };
  const rows = [row({ product_id: "p1", exported_sku: null }), row({ product_id: "p2", exported_sku: null })];
  assert.equal(Object.keys(old(rows)).length, 0, "this is the bug being fixed");
  const fixed = buildChannelIdentityIndex({ rows, storefrontKey: "rafeeq:malikas",
    canonicalSkuForRow: (r) => (r.product_id === "p1" ? "mk1" : "mk2"), toEvidence: ev });
  assert.equal(Object.keys(fixed.index).length, 2);
});

// ── wiring: one rule, applied everywhere, Shopify untouched ──────────────────
test("14 · all three affected loaders use the shared rule and no local fallback", () => {
  for (const loader of [RAFEEQ, SNOONU, TALABAT]) {
    const src = code(loader);
    assert.ok(src.includes("buildChannelIdentityIndex"), `${loader} uses the shared builder`);
    assert.ok(!/const sku = s\(e\.exported_sku\);\s*if \(!sku\) continue;/.test(src), `${loader} no longer drops empty exported_sku`);
  }
});

test("15 · Shopify is untouched — it never keyed on exported_sku", () => {
  const src = code(SHOPIFY);
  assert.ok(!src.includes("exported_sku"), "the Shopify preview does not read the column at all");
  assert.ok(!src.includes("buildChannelIdentityIndex"), "and is not rewired by this change");
});

test("16 · Talabat now selects product_id so a fallback is even possible", () => {
  const src = code(TALABAT);
  const sel = /readAll\(\s*client,\s*"external_channel_listings",\s*"([^"]+)"/.exec(src)?.[1] ?? "";
  assert.ok(sel.includes("product_id"), "product_id is selected");
  assert.ok(sel.includes("variant_id"), "variant_id is selected so variant identity stays variant-specific");
});

test("17 · ECL pagination no longer orders by the all-NULL exported_sku column", () => {
  for (const loader of [RAFEEQ, SNOONU, TALABAT]) {
    const src = code(loader);
    const m = /readAll\(\s*client,\s*"external_channel_listings",\s*"[^"]+",\s*"([^"]+)"/.exec(src);
    assert.equal(m?.[1], "product_id", `${loader}: offset pagination needs a non-null ordering key`);
  }
});
