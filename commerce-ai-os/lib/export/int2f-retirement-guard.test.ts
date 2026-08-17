// INT.2F — Legacy export retirement guard (source scan). Proves the legacy
// export platform is retired and the Export Center (/v2/export) is the sole
// export system, WITHOUT breaking the two documented retained capabilities:
//   • the Talabat legacy route branch (sole writer of channel_variant_mappings —
//     order-deduction identity, unreplaced), and
//   • /api/export/images (retained: TalabatSync image-delivery dependency).
// node --conditions=react-server --experimental-strip-types --test lib/export/int2f-retirement-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const exists = (rel: string) => existsSync(join(ROOT, rel));

const LEGACY_ROUTE = "app/api/export/[channel]/route.ts";
const EXPORTERS = "lib/exporters.ts";
const SHOPIFY_SYNC = "components/ShopifySync.tsx";
const EXPORT_PAGE = "app/(app)/import-export/export/page.tsx";

// ── legacy per-channel exports retired → 410 → Export Center ───────────────────
test("legacy Shopify/Snoonu/Rafeeq channel exports are retired (410 → Export Center)", () => {
  const r = read(LEGACY_ROUTE);
  for (const dest of ["/v2/export/shopify:malikas", "/v2/export/snoonu:malikas", "/v2/export/rafeeq:malikas"]) {
    assert.ok(r.includes(dest), `retired map points to ${dest}`);
  }
  assert.ok(/status: 410/.test(r), "retired channels return 410");
  assert.equal(/buildShopifyCsv|buildSnoonuCsv|buildRafeeqAoa|buildRafeeqCsv/.test(r), false, "no legacy CSV/AoA builders in the route");
});

// ── Talabat branch retained solely as the channel_variant_mappings writer ─────
test("the Talabat legacy branch is retained as the mappings writer (unreplaced capability)", () => {
  const r = read(LEGACY_ROUTE);
  assert.ok(/channel !== "talabat"/.test(r), "only Talabat proceeds");
  assert.ok(/persistTalabatMappings\(/.test(r), "still persists channel_variant_mappings");
  assert.ok(/requireMalakWriter\(\)/.test(r), "writer-gated");
});

// ── no legacy identity columns / no fuzzy product matching in the retired path ─
test("the retired export flow reads no legacy identity columns", () => {
  const r = read(LEGACY_ROUTE);
  assert.equal(/snoonu_id|rafeeq_product_id|pure_seoul_id/.test(r), false, "no legacy id columns in the route");
  // Talabat resolves its EXACT channel (certified) — not a product fuzzy match.
  assert.ok(/resolveExactChannelId\(/.test(r), "exact channel resolution retained");
});

// ── lib/exporters.ts is template-only (legacy builders + identity removed) ─────
test("lib/exporters.ts keeps only certified templates", () => {
  const e = read(EXPORTERS);
  for (const keep of ["SNOONU_HEADERS", "RAFEEQ_HEADERS", "RAFEEQ_CATEGORIES", "RAFEEQ_COL_WIDTHS"]) {
    assert.ok(e.includes(`export const ${keep}`), `retains ${keep}`);
  }
  assert.equal(/export function build(Shopify|Snoonu|Rafeeq)/.test(e), false, "no legacy builders");
  assert.equal(/snoonu_id|rafeeq_product_id/.test(e), false, "no legacy identity fields");
});

// ── the legacy export UI component is deleted ─────────────────────────────────
test("ExportButtons (legacy per-channel export UI) is deleted", () => {
  assert.equal(exists("components/ExportButtons.tsx"), false, "ExportButtons.tsx removed");
  assert.equal(/ExportButtons/.test(read(EXPORT_PAGE)), false, "export page no longer renders ExportButtons");
});

// ── the legacy Shopify operator push is retired from ShopifySync ──────────────
test("ShopifySync no longer offers the legacy Shopify catalog push (uses Export Center)", () => {
  const s = read(SHOPIFY_SYNC);
  for (const gone of ["applyShopifyPrices", "applyShopifyContent", "pushProductsToShopify"]) {
    assert.equal(s.includes(gone), false, `ShopifySync must not call ${gone}`);
  }
  assert.ok(/\/v2\/export\/shopify:malikas/.test(s), "points operators to the Export Center publisher");
  // retained sync capabilities stay
  for (const keep of ["computeShopifyDiff", "syncShopifyInventory", "importShopifyProducts", "pushShopifyImages"]) {
    assert.ok(s.includes(keep), `retains ${keep}`);
  }
});

// ── the Export Center is the sole export system (its routes exist) ────────────
test("the Export Center package/publish routes are the sole export system", () => {
  for (const route of [
    "app/api/export/talabat/package/route.ts",
    "app/api/export/snoonu/[unit]/package/route.ts",
    "app/api/export/rafeeq/package/route.ts",
    "app/api/export/shopify/publish/route.ts",
  ]) {
    assert.ok(exists(route), `${route} exists`);
  }
});
