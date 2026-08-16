// BI.1 — Analytics Read Layer (pure core).
//
// The single, deterministic contract every management / analytics surface (BI.2
// Executive Dashboard and beyond) consumes. It defines the metric vocabulary
// (Sales, Inventory, Catalog Quality, KPI header) and the PURE assembler
// `buildAnalyticsSnapshot` that turns already-fetched inputs into that contract.
// No IO, no DB, no SDK, no clock — the server layer feeds it data + a timestamp.
//
// Honesty invariants (read-only foundation; scope confirmed by the owner):
//   • Time-windowed sales (today / yesterday / week / month) and growth % have NO
//     honest source in the current data model — units-sold is a lifetime-cumulative
//     figure, not a dated ledger, and the only trend mechanism writes on a schedule.
//     They are therefore ALWAYS reported as UNKNOWN, never fabricated.
//   • Lifetime sales totals ARE honest and are exposed as such, clearly labelled.
//   • Any metric whose upstream source is unavailable degrades to UNKNOWN — never to
//     a zero that could be mistaken for a real measurement.
//   • This layer performs NO calculations of its own beyond selecting/shaping the
//     values handed to it: inventory analytics, sales totals, low-stock counts and
//     catalog-quality counts are computed by the existing canonical engines and
//     passed in. BI.1 never re-derives a metric a certified engine already owns.

/** Whether a metric carries a real measurement or is honestly unknown. */
export type MetricStatus = "available" | "unknown";

/** A single metric: a real value, or an explicit UNKNOWN (value === null). */
export interface Metric<T> {
  status: MetricStatus;
  value: T | null;
}

/** Wrap a real, measured value. */
export const available = <T>(value: T): Metric<T> => ({ status: "available", value });

/** An honestly-unknown metric — the only way BI.1 represents "no source". */
export const unknown = <T = number>(): Metric<T> => ({ status: "unknown", value: null });

/**
 * Lift a nullable number into a Metric: null/undefined → UNKNOWN, otherwise
 * available. This is the single choke-point that guarantees BI.1 never turns a
 * missing source into a fake zero.
 */
export const fromNullable = (n: number | null | undefined): Metric<number> =>
  n == null ? unknown<number>() : available(n);

// ── Sales ────────────────────────────────────────────────────────────────────

/** Units + revenue for a time window (both UNKNOWN when the window has no source). */
export interface SalesWindow {
  units: Metric<number>;
  revenue: Metric<number>;
}

const unknownWindow = (): SalesWindow => ({ units: unknown(), revenue: unknown() });

export interface SalesAnalytics {
  today: SalesWindow; // UNKNOWN — no dated sales ledger
  yesterday: SalesWindow; // UNKNOWN
  week: SalesWindow; // UNKNOWN
  month: SalesWindow; // UNKNOWN
  growthPct: Metric<number>; // UNKNOWN — needs day-over-day history
  /** Honest, source-backed cumulative totals across the whole catalogue. */
  lifetime: {
    units: Metric<number>;
    revenue: Metric<number>;
    distinctProducts: Metric<number>;
  };
}

// ── Inventory ──────────────────────────────────────────────────────────────────

export interface InventoryValue {
  atCost: Metric<number>;
  atPrice: Metric<number>;
}

export interface InventoryAnalyticsView {
  totalSkus: Metric<number>;
  totalUnits: Metric<number>;
  lowStock: Metric<number>;
  outOfStock: Metric<number>;
  deadStock: Metric<number>; // count of dead-stock SKUs
  deadStockUnits: Metric<number>;
  value: InventoryValue; // "inventory value (if available)"
  fastMoving: Metric<number>; // UNKNOWN — needs velocity/time we do not track
}

// ── Catalog quality ────────────────────────────────────────────────────────────

export interface CatalogQualityAnalytics {
  missingImages: Metric<number>;
  missingBarcode: Metric<number>;
  missingCategory: Metric<number>;
  missingPrice: Metric<number>;
  missingKeywords: Metric<number>; // cheap head-count when available, else UNKNOWN
  missingDescription: Metric<number>; // cheap head-count when available, else UNKNOWN
  needsAi: Metric<number>; // UNKNOWN — requires the heavy enrichment classifier
  needsMapping: Metric<number>; // ECL needs_review head-count, else UNKNOWN
}

// ── KPI header (aggregate view for the dashboard header) ─────────────────────────

export interface KpiHeaderAnalytics {
  totalProducts: Metric<number>;
  activeChannels: Metric<number>;
  inventoryUnits: Metric<number>;
  inventoryValueAtPrice: Metric<number>;
  todaySales: SalesWindow; // mirrors sales.today → UNKNOWN
  monthSales: SalesWindow; // mirrors sales.month → UNKNOWN
  orders: Metric<number>; // UNKNOWN — no cheap cross-channel order count
}

// ── Snapshot + input contract ───────────────────────────────────────────────────

export interface AnalyticsSnapshot {
  configured: boolean;
  generatedAt: string; // injected ISO timestamp — the pure layer owns no clock
  sales: SalesAnalytics;
  inventory: InventoryAnalyticsView;
  catalogQuality: CatalogQualityAnalytics;
  kpi: KpiHeaderAnalytics;
}

/**
 * Everything the server assembler has already fetched/computed, in the exact shape
 * BI.1 shapes into the snapshot. Every section is optional/nullable: a missing
 * section degrades its metrics to UNKNOWN rather than fabricating values.
 */
export interface AnalyticsReadInput {
  configured: boolean;
  generatedAt: string;
  /** From the canonical inventory engine (computeAnalytics). */
  inventory?: {
    valuation: { skus: number; units: number; atCost: number; atPrice: number };
    deadStock: { count: number; units: number };
  } | null;
  /** From the canonical low-stock engine (computeLowStock). */
  lowStock?: { lowCount: number; outCount: number } | null;
  /** From the canonical sales engine (computeSalesSummary) — lifetime cumulative. */
  lifetimeSales?: { totalUnits: number; totalRevenue: number; distinctProducts: number } | null;
  /** Catalog-quality + header counts, mostly from getCeoKpis (canonical KPI reader). */
  catalog?: {
    totalProducts: number;
    activeChannels: number;
    inventoryUnits: number;
    missingImages: number;
    missingBarcode: number;
    missingCategory: number;
    missingPrice: number;
    /** null → UNKNOWN (source unavailable / column absent). */
    missingDescription?: number | null;
    missingKeywords?: number | null;
    needsMapping?: number | null;
  } | null;
}

const emptySales = (): SalesAnalytics => ({
  today: unknownWindow(),
  yesterday: unknownWindow(),
  week: unknownWindow(),
  month: unknownWindow(),
  growthPct: unknown(),
  lifetime: { units: unknown(), revenue: unknown(), distinctProducts: unknown() },
});

/**
 * Deterministically shape fetched inputs into the analytics contract. Pure: same
 * input → same output; missing input → UNKNOWN. Never throws, never fabricates.
 */
export function buildAnalyticsSnapshot(input: AnalyticsReadInput): AnalyticsSnapshot {
  const inv = input.inventory ?? null;
  const low = input.lowStock ?? null;
  const life = input.lifetimeSales ?? null;
  const cat = input.catalog ?? null;

  const sales: SalesAnalytics = {
    ...emptySales(),
    lifetime: {
      units: fromNullable(life?.totalUnits),
      revenue: fromNullable(life?.totalRevenue),
      distinctProducts: fromNullable(life?.distinctProducts),
    },
  };

  const inventory: InventoryAnalyticsView = {
    totalSkus: fromNullable(inv?.valuation.skus),
    totalUnits: fromNullable(inv?.valuation.units),
    lowStock: fromNullable(low?.lowCount),
    outOfStock: fromNullable(low?.outCount),
    deadStock: fromNullable(inv?.deadStock.count),
    deadStockUnits: fromNullable(inv?.deadStock.units),
    value: {
      atCost: fromNullable(inv?.valuation.atCost),
      atPrice: fromNullable(inv?.valuation.atPrice),
    },
    fastMoving: unknown(), // no velocity source in the current data model
  };

  const catalogQuality: CatalogQualityAnalytics = {
    missingImages: fromNullable(cat?.missingImages),
    missingBarcode: fromNullable(cat?.missingBarcode),
    missingCategory: fromNullable(cat?.missingCategory),
    missingPrice: fromNullable(cat?.missingPrice),
    missingKeywords: fromNullable(cat?.missingKeywords ?? null),
    missingDescription: fromNullable(cat?.missingDescription ?? null),
    needsAi: unknown(), // heavy enrichment classifier — not in the cheap read path
    needsMapping: fromNullable(cat?.needsMapping ?? null),
  };

  const kpi: KpiHeaderAnalytics = {
    totalProducts: fromNullable(cat?.totalProducts),
    activeChannels: fromNullable(cat?.activeChannels),
    inventoryUnits: fromNullable(cat?.inventoryUnits),
    inventoryValueAtPrice: inventory.value.atPrice,
    todaySales: sales.today,
    monthSales: sales.month,
    orders: unknown(), // no cheap cross-channel order count in the read path
  };

  return {
    configured: input.configured,
    generatedAt: input.generatedAt,
    sales,
    inventory,
    catalogQuality,
    kpi,
  };
}
