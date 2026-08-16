// BI.2 — Executive Dashboard (pure view-model core).
//
// Turns the BI.1 AnalyticsSnapshot into the presentational view models the
// Executive Dashboard renders: the KPI header, Sales Overview, Inventory
// Overview, Catalog Quality and the Operations Summary queue cards, plus the
// deep-link routes and the dashboard search target.
//
// Pure & deterministic: no IO, no DB, no clock, no @/ imports. It consumes ONLY
// the BI.1 contract (imported by relative path) — it never re-derives a metric
// and never queries a business table. Anything BI.1 reports as UNKNOWN is
// rendered as an explicit em dash, never a fabricated zero. The operational
// sections (channels, health, alerts) are adapted from the certified OPS read
// models directly in the section components, so this core stays BI.1-only and
// fully unit-testable.

import type { AnalyticsSnapshot, Metric, SalesWindow } from "./analytics-read.ts";

/** How an UNKNOWN metric is rendered — an explicit em dash, never "0". */
export const UNKNOWN_TEXT = "—";

/** Deterministic thousands separator (locale-independent for stable tests). */
export function fmtInt(n: number): string {
  const neg = n < 0;
  const s = Math.abs(Math.round(n)).toString();
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ",";
    out += s[i];
  }
  return neg ? `-${out}` : out;
}

/** Qatari-riyal amount, e.g. "ر.ق 90,000". */
export function fmtCurrency(n: number): string {
  return `ر.ق ${fmtInt(n)}`;
}

/** Render an integer metric: value or UNKNOWN em dash (never a fake zero). */
export function metricInt(m: Metric<number>): string {
  return m.status === "available" && m.value != null ? fmtInt(m.value) : UNKNOWN_TEXT;
}

/** Render a currency metric: value or UNKNOWN em dash. */
export function metricCurrency(m: Metric<number>): string {
  return m.status === "available" && m.value != null ? fmtCurrency(m.value) : UNKNOWN_TEXT;
}

// ── Deep-link routes (existing workflows only) ─────────────────────────────────

export const ROUTES = {
  analytics: "/v2/analytics",
  media: "/v2/operations/media",
  ai: "/v2/operations/ai",
  availability: "/v2/operations/availability-sync",
  barcode: "/v2/operations/barcode-completion",
  missingProducts: "/v2/operations/missing-products",
  channels: "/v2/operations/channels",
  health: "/v2/operations/health",
  catalog: "/v2/catalog",
} as const;

// ── KPI header (§2) ────────────────────────────────────────────────────────────

export interface KpiCard {
  key: string;
  label: string;
  value: string;
  status: "available" | "unknown";
  /** an honest one-line hint (e.g. why a value is unknown). */
  hint?: string;
}

const statusOf = (m: Metric<number>): "available" | "unknown" => m.status;

/**
 * The analytics-backed KPI cards (Platform Health is streamed separately from
 * OPS.6 and is not part of this pure, BI.1-only set). Order matches the spec:
 * Today's Sales, Month Sales, Products, Inventory Value, Orders, Active Channels.
 */
export function buildKpiCards(s: AnalyticsSnapshot): KpiCard[] {
  const todayRev = s.kpi.todaySales.revenue;
  const monthRev = s.kpi.monthSales.revenue;
  return [
    {
      key: "today_sales",
      label: "مبيعات اليوم",
      value: metricCurrency(todayRev),
      status: statusOf(todayRev),
      hint: todayRev.status === "unknown" ? "لا يوجد سجل مبيعات مؤرَّخ" : undefined,
    },
    {
      key: "month_sales",
      label: "مبيعات الشهر",
      value: metricCurrency(monthRev),
      status: statusOf(monthRev),
      hint: monthRev.status === "unknown" ? "لا يوجد سجل مبيعات مؤرَّخ" : undefined,
    },
    { key: "products", label: "المنتجات", value: metricInt(s.kpi.totalProducts), status: statusOf(s.kpi.totalProducts) },
    {
      key: "inventory_value",
      label: "قيمة المخزون",
      value: metricCurrency(s.kpi.inventoryValueAtPrice),
      status: statusOf(s.kpi.inventoryValueAtPrice),
    },
    {
      key: "orders",
      label: "الطلبات",
      value: metricInt(s.kpi.orders),
      status: statusOf(s.kpi.orders),
      hint: s.kpi.orders.status === "unknown" ? "لا يتوفّر عدّ طلبات موحّد" : undefined,
    },
    { key: "active_channels", label: "القنوات النشطة", value: metricInt(s.kpi.activeChannels), status: statusOf(s.kpi.activeChannels) },
  ];
}

// ── Sales Overview (§3) ─────────────────────────────────────────────────────────

export interface SalesRowView {
  key: string;
  label: string;
  units: string;
  revenue: string;
  status: "available" | "unknown";
}

const windowRow = (key: string, label: string, w: SalesWindow): SalesRowView => ({
  key,
  label,
  units: metricInt(w.units),
  revenue: metricCurrency(w.revenue),
  status: w.units.status === "available" || w.revenue.status === "available" ? "available" : "unknown",
});

export interface SalesOverviewView {
  rows: SalesRowView[];
  growth: { value: string; status: "available" | "unknown" };
  lifetime: SalesRowView;
}

export function buildSalesOverview(s: AnalyticsSnapshot): SalesOverviewView {
  const sa = s.sales;
  return {
    rows: [
      windowRow("today", "اليوم", sa.today),
      windowRow("yesterday", "الأمس", sa.yesterday),
      windowRow("week", "الأسبوع", sa.week),
      windowRow("month", "الشهر", sa.month),
    ],
    growth: {
      value: sa.growthPct.status === "available" && sa.growthPct.value != null ? `${sa.growthPct.value}%` : UNKNOWN_TEXT,
      status: sa.growthPct.status,
    },
    lifetime: {
      key: "lifetime",
      label: "الإجمالي التراكمي",
      units: metricInt(sa.lifetime.units),
      revenue: metricCurrency(sa.lifetime.revenue),
      status: sa.lifetime.units.status,
    },
  };
}

// ── Inventory Overview (§4) ─────────────────────────────────────────────────────

export interface StatCell {
  key: string;
  label: string;
  value: string;
  status: "available" | "unknown";
}

export function buildInventoryOverview(s: AnalyticsSnapshot): StatCell[] {
  const inv = s.inventory;
  return [
    { key: "total_stock", label: "إجمالي المخزون", value: metricInt(inv.totalUnits), status: statusOf(inv.totalUnits) },
    { key: "low_stock", label: "مخزون منخفض", value: metricInt(inv.lowStock), status: statusOf(inv.lowStock) },
    { key: "out_of_stock", label: "نفدت الكمية", value: metricInt(inv.outOfStock), status: statusOf(inv.outOfStock) },
    { key: "dead_stock", label: "مخزون راكد", value: metricInt(inv.deadStock), status: statusOf(inv.deadStock) },
    {
      key: "fast_moving",
      label: "سريع الحركة",
      value: metricInt(inv.fastMoving),
      status: statusOf(inv.fastMoving),
    },
  ];
}

// ── Catalog Quality (§6) ─────────────────────────────────────────────────────────

export interface CatalogQualityCell extends StatCell {
  href: string;
}

export function buildCatalogQuality(s: AnalyticsSnapshot): CatalogQualityCell[] {
  const q = s.catalogQuality;
  return [
    { key: "missing_images", label: "صور ناقصة", value: metricInt(q.missingImages), status: statusOf(q.missingImages), href: ROUTES.media },
    { key: "missing_barcode", label: "باركود ناقص", value: metricInt(q.missingBarcode), status: statusOf(q.missingBarcode), href: ROUTES.barcode },
    { key: "missing_keywords", label: "كلمات مفتاحية ناقصة", value: metricInt(q.missingKeywords), status: statusOf(q.missingKeywords), href: ROUTES.ai },
    { key: "missing_description", label: "وصف ناقص", value: metricInt(q.missingDescription), status: statusOf(q.missingDescription), href: ROUTES.ai },
    { key: "needs_ai", label: "يحتاج ذكاء", value: metricInt(q.needsAi), status: statusOf(q.needsAi), href: ROUTES.ai },
    { key: "needs_mapping", label: "يحتاج ربطًا", value: metricInt(q.needsMapping), status: statusOf(q.needsMapping), href: ROUTES.missingProducts },
  ];
}

// ── Operations Summary (§7) — workflow queue cards ───────────────────────────────
//
// Media & Barcode counts come honestly from BI.1 catalog quality; AI, Availability
// and Missing-Products have no cheap honest count in the analytics layer and are
// shown as UNKNOWN. Every card deep-links to its existing Operations workflow.

export interface QueueCardView {
  key: string;
  label: string;
  value: string;
  status: "available" | "unknown";
  href: string;
}

export function buildOperationsSummary(s: AnalyticsSnapshot): QueueCardView[] {
  const q = s.catalogQuality;
  return [
    { key: "media", label: "طابور الوسائط", value: metricInt(q.missingImages), status: statusOf(q.missingImages), href: ROUTES.media },
    { key: "ai", label: "طابور الذكاء", value: metricInt(q.needsAi), status: statusOf(q.needsAi), href: ROUTES.ai },
    { key: "availability", label: "طابور التوفّر", value: UNKNOWN_TEXT, status: "unknown", href: ROUTES.availability },
    { key: "barcode", label: "طابور الباركود", value: metricInt(q.missingBarcode), status: statusOf(q.missingBarcode), href: ROUTES.barcode },
    { key: "missing_products", label: "طابور المنتجات الناقصة", value: UNKNOWN_TEXT, status: "unknown", href: ROUTES.missingProducts },
  ];
}

// ── Search (§10) — delegate to the existing catalog search ────────────────────────

export type SearchField = "all" | "sku" | "product" | "barcode" | "brand";

const SEARCH_FIELDS: readonly SearchField[] = ["all", "sku", "product", "barcode", "brand"];

export function parseSearchField(v: unknown): SearchField {
  return typeof v === "string" && (SEARCH_FIELDS as readonly string[]).includes(v) ? (v as SearchField) : "all";
}

/** Sanitise a free-text query (trim, cap length) before it reaches a link. */
export function sanitizeQuery(v: unknown): string {
  return typeof v === "string" ? v.trim().slice(0, 120) : "";
}

/** Deep-link to the existing catalog search (delegation, no new search engine). */
export function searchHref(q: string, field: SearchField): string {
  const query = sanitizeQuery(q);
  if (!query) return ROUTES.catalog;
  const params = new URLSearchParams({ q: query });
  if (field !== "all") params.set("field", field);
  return `${ROUTES.catalog}?${params.toString()}`;
}

// ── Top-level assembly ───────────────────────────────────────────────────────────

export interface ExecutiveDashboardView {
  generatedAt: string;
  configured: boolean;
  kpis: KpiCard[];
  sales: SalesOverviewView;
  inventory: StatCell[];
  catalogQuality: CatalogQualityCell[];
  operations: QueueCardView[];
}

/** Assemble the analytics-backed dashboard view model (pure). */
export function buildExecutiveDashboard(s: AnalyticsSnapshot): ExecutiveDashboardView {
  return {
    generatedAt: s.generatedAt,
    configured: s.configured,
    kpis: buildKpiCards(s),
    sales: buildSalesOverview(s),
    inventory: buildInventoryOverview(s),
    catalogQuality: buildCatalogQuality(s),
    operations: buildOperationsSummary(s),
  };
}
