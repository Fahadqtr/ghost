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

// ── ALL legacy per-channel exports retired → 410 → Export Center (INT.2F.2) ────
test("legacy Shopify/Snoonu/Rafeeq AND Talabat channel exports are retired (410 → Export Center)", () => {
  const r = read(LEGACY_ROUTE);
  for (const dest of ["/v2/export/shopify:malikas", "/v2/export/snoonu:malikas", "/v2/export/rafeeq:malikas", "/v2/export/talabat:malikas"]) {
    assert.ok(r.includes(dest), `retired map points to ${dest}`);
  }
  assert.ok(/status: 410/.test(r), "retired channels return 410");
  assert.equal(/buildShopifyCsv|buildSnoonuCsv|buildRafeeqAoa|buildRafeeqCsv|buildTalabatExport|talabatResultToCsv/.test(r), false, "no legacy CSV/AoA builders in the route");
});

// ── Talabat CSV branch FULLY retired; mapping persistence re-homed (INT.2F.2) ──
test("the Talabat CSV branch is retired and channel_variant_mappings persistence is re-homed", () => {
  const r = read(LEGACY_ROUTE);
  // The route no longer flattens, gates, or persists anything for Talabat.
  assert.equal(/syncTalabatMappings|persistTalabatMappings|buildTalabatExport/.test(r), false, "no mapping persistence remains in the retired route");
  // Mapping persistence now lives in the certified catalog-sync helper …
  const sync = read("lib/talabat/mapping-sync/catalog-sync.server.ts");
  assert.ok(/import "server-only"/.test(sync), "catalog-sync is server-only");
  assert.ok(/syncTalabatMappings\(/.test(sync), "persists via the INT.2F.1 boundary");
  // … triggered by the writer-gated certified package route.
  const pkg = read("app/api/export/talabat/package/route.ts");
  assert.ok(/requireMalakWriter\(\)/.test(pkg) && /syncTalabatMappingsFromCatalog\(/.test(pkg), "package route is writer-gated and triggers the sync");
});

// ── no legacy identity columns / no fuzzy product matching in the re-homed path ─
test("the re-homed mapping flow reads no legacy identity columns and resolves the exact channel", () => {
  const r = read(LEGACY_ROUTE);
  assert.equal(/snoonu_id|rafeeq_product_id|pure_seoul_id/.test(r), false, "no legacy id columns in the retired route");
  const sync = read("lib/talabat/mapping-sync/catalog-sync.server.ts");
  assert.equal(/snoonu_id|rafeeq_product_id|pure_seoul_id/.test(sync), false, "no legacy id columns in catalog-sync");
  assert.ok(/resolveExactChannelId\(/.test(sync), "exact channel resolution retained (never a fuzzy sibling)");
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
