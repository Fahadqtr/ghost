// BI.2 — Executive Dashboard, pure view-model tests.
// node --conditions=react-server --experimental-strip-types --test lib/analytics/executive-dashboard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { buildAnalyticsSnapshot, type AnalyticsReadInput } from "./analytics-read.ts";
import {
  buildExecutiveDashboard,
  buildKpiCards,
  buildSalesOverview,
  buildInventoryOverview,
  buildCatalogQuality,
  buildOperationsSummary,
  fmtInt,
  fmtCurrency,
  UNKNOWN_TEXT,
  parseSearchField,
  sanitizeQuery,
  searchHref,
  ROUTES,
} from "./executive-dashboard.ts";

const AT = "2026-08-16T00:00:00.000Z";

const snap = (over: Partial<AnalyticsReadInput> = {}) =>
  buildAnalyticsSnapshot({
    configured: true,
    generatedAt: AT,
    inventory: { valuation: { skus: 120, units: 3400, atCost: 50000, atPrice: 90000 }, deadStock: { count: 7, units: 210 } },
    lowStock: { lowCount: 12, outCount: 4 },
    lifetimeSales: { totalUnits: 8800, totalRevenue: 220000, distinctProducts: 95 },
    catalog: {
      totalProducts: 130,
      activeChannels: 3,
      inventoryUnits: 3400,
      missingImages: 10,
      missingBarcode: 22,
      missingCategory: 5,
      missingPrice: 1,
      missingDescription: 40,
      missingKeywords: 55,
      needsMapping: 8,
    },
    ...over,
  });

// ── formatting ────────────────────────────────────────────────────────────────
test("fmtInt groups thousands; fmtCurrency prefixes QAR", () => {
  assert.equal(fmtInt(0), "0");
  assert.equal(fmtInt(3400), "3,400");
  assert.equal(fmtInt(1234567), "1,234,567");
  assert.equal(fmtCurrency(90000), "ر.ق 90,000");
});

// ── KPI header (§2) ─────────────────────────────────────────────────────────────
test("KPI cards: products/inventory-value/channels honest; sales+orders unknown", () => {
  const cards = buildKpiCards(snap());
  const by = Object.fromEntries(cards.map((c) => [c.key, c]));
  assert.equal(by.products.value, "130");
  assert.equal(by.products.status, "available");
  assert.equal(by.inventory_value.value, "ر.ق 90,000");
  assert.equal(by.active_channels.value, "3");
  assert.equal(by.today_sales.value, UNKNOWN_TEXT);
  assert.equal(by.today_sales.status, "unknown");
  assert.equal(by.month_sales.status, "unknown");
  assert.equal(by.orders.status, "unknown");
  // Platform Health is NOT part of the pure BI.1-only KPI set (streamed from OPS.6)
  assert.equal(by.platform_health, undefined);
});

// ── Sales Overview (§3) ─────────────────────────────────────────────────────────
test("sales windows all unknown; lifetime honest; growth unknown", () => {
  const s = buildSalesOverview(snap());
  for (const r of s.rows) assert.equal(r.status, "unknown", `${r.key} window is unknown`);
  assert.equal(s.growth.value, UNKNOWN_TEXT);
  assert.equal(s.lifetime.units, "8,800");
  assert.equal(s.lifetime.revenue, "ر.ق 220,000");
});

// ── Inventory Overview (§4) ─────────────────────────────────────────────────────
test("inventory overview maps totals/low/out/dead; fast-moving unknown", () => {
  const cells = Object.fromEntries(buildInventoryOverview(snap()).map((c) => [c.key, c]));
  assert.equal(cells.total_stock.value, "3,400");
  assert.equal(cells.low_stock.value, "12");
  assert.equal(cells.out_of_stock.value, "4");
  assert.equal(cells.dead_stock.value, "7");
  assert.equal(cells.fast_moving.status, "unknown");
});

// ── Catalog Quality (§6) ─────────────────────────────────────────────────────────
test("catalog quality cells carry counts + workflow deep-links; needsAi unknown", () => {
  const cells = Object.fromEntries(buildCatalogQuality(snap()).map((c) => [c.key, c]));
  assert.equal(cells.missing_images.value, "10");
  assert.equal(cells.missing_images.href, ROUTES.media);
  assert.equal(cells.missing_barcode.href, ROUTES.barcode);
  assert.equal(cells.needs_mapping.href, ROUTES.missingProducts);
  assert.equal(cells.needs_ai.status, "unknown");
});

// ── Operations Summary (§7) ─────────────────────────────────────────────────────
test("operations summary: media/barcode honest from BI.1; ai/availability/missing unknown; all linked", () => {
  const cells = Object.fromEntries(buildOperationsSummary(snap()).map((c) => [c.key, c]));
  assert.equal(cells.media.value, "10");
  assert.equal(cells.media.href, ROUTES.media);
  assert.equal(cells.barcode.value, "22");
  assert.equal(cells.ai.status, "unknown");
  assert.equal(cells.availability.status, "unknown");
  assert.equal(cells.availability.href, ROUTES.availability);
  assert.equal(cells.missing_products.status, "unknown");
  assert.equal(cells.missing_products.href, ROUTES.missingProducts);
});

// ── unavailable snapshot → everything unknown (never fabricated) ─────────────────
test("unconfigured snapshot renders every value as UNKNOWN, not zero", () => {
  const v = buildExecutiveDashboard(buildAnalyticsSnapshot({ configured: false, generatedAt: AT }));
  assert.equal(v.configured, false);
  for (const c of v.kpis) assert.equal(c.value === "0" || c.value === "ر.ق 0", false, `${c.key} is not a fake zero`);
  assert.equal(v.inventory.every((c) => c.status === "unknown"), true);
  assert.equal(v.catalogQuality.every((c) => c.status === "unknown"), true);
});

// ── Search (§10) — delegate to catalog ───────────────────────────────────────────
test("search field parsing + href delegation to /v2/catalog", () => {
  assert.equal(parseSearchField("sku"), "sku");
  assert.equal(parseSearchField("nonsense"), "all");
  assert.equal(sanitizeQuery("  abc  "), "abc");
  assert.equal(sanitizeQuery("x".repeat(200)).length, 120);
  assert.equal(searchHref("", "all"), ROUTES.catalog);
  assert.equal(searchHref("lipstick", "product"), `${ROUTES.catalog}?q=lipstick&field=product`);
  assert.equal(searchHref("123", "all"), `${ROUTES.catalog}?q=123`);
});

// ── determinism ──────────────────────────────────────────────────────────────────
test("same snapshot → identical dashboard view (pure)", () => {
  assert.deepEqual(buildExecutiveDashboard(snap()), buildExecutiveDashboard(snap()));
});
