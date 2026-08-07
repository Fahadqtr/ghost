import "server-only";
// Malikas V2 Operations — server-side read model (Phase UI.7.2).
//
// The ONLY job here is I/O + wiring: read whitelisted Malikas rows through the
// passed-in session client (RLS; no service role, no admin client, no write,
// no RPC), optionally read Shopify presence through the EXISTING UI.3 read
// model, build OperationsProduct[], and hand them to the pure lib/operations
// engines. NO business logic lives here — readiness/tasks/platforms/health
// rules stay in the engines.
//
// Runtime values (the pure engines + the Shopify reader) are loaded lazily and
// are injectable, so node:test can load this file (only `import type` is
// resolved statically). Malikas always renders even if Shopify is unavailable
// — a degraded flag is returned instead of guessing "missing".

import type {
  HealthSummary,
  NewProductBuckets,
  OperationsProduct,
  OperationTask,
  PlatformPresence,
  PlatformStatus,
  PlatformType,
  ProductReadiness,
} from "./shared/models";
import type { OperationsListItem } from "./dashboard-view";

// ── minimal read surfaces (only what this reader needs) ──────────────────────

interface QueryResult {
  data: unknown[] | null;
  error: unknown | null;
}
interface RangeBuilder extends PromiseLike<QueryResult> {
  order(column: string, options: { ascending: boolean }): RangeBuilder;
  range(from: number, to: number): RangeBuilder;
}
interface SelectBuilder {
  select(columns: string): RangeBuilder;
}
export interface OperationsReadClient {
  from(table: string): SelectBuilder;
}

/** The pure engine surface (injected in tests; lazily bound in production). */
export interface OperationsEngines {
  computeProductReadiness(p: OperationsProduct): ProductReadiness;
  computePlatformStatuses(p: OperationsProduct, readyToPublish: boolean): PlatformStatus[];
  generateProductTasks(
    p: OperationsProduct,
    r: ProductReadiness,
    s: readonly PlatformStatus[],
  ): OperationTask[];
  classifyNewProducts(r: readonly ProductReadiness[]): NewProductBuckets;
  computeHealthSummary(r: readonly ProductReadiness[], t: readonly OperationTask[]): HealthSummary;
  toListItem(
    p: OperationsProduct,
    r: ProductReadiness,
    t: readonly OperationTask[],
    s: readonly PlatformStatus[],
  ): OperationsListItem;
  mapProductRow(
    row: Record<string, unknown>,
    variantCount: number,
    platforms?: Partial<Record<PlatformType, PlatformPresence>>,
  ): OperationsProduct;
}

async function defaultEngines(): Promise<OperationsEngines> {
  const [readiness, platforms, tasks, np, health, view] = await Promise.all([
    import("./readiness/readiness"),
    import("./platforms/platform-status"),
    import("./tasks/task-engine"),
    import("./new-products/new-product-engine"),
    import("./health/health-engine"),
    import("./dashboard-view"),
  ]);
  return {
    computeProductReadiness: readiness.computeProductReadiness,
    computePlatformStatuses: platforms.computePlatformStatuses,
    generateProductTasks: tasks.generateProductTasks,
    classifyNewProducts: np.classifyNewProducts,
    computeHealthSummary: health.computeHealthSummary,
    toListItem: view.toListItem,
    mapProductRow: view.mapProductRow,
  };
}

/** A Shopify presence reader (injected in tests; the UI.3 read model in prod). */
export interface ShopifyPresenceReader {
  loadShopifyPresence(
    client: OperationsReadClient,
  ): Promise<{ available: boolean; byProductId: Map<string, PlatformPresence> }>;
}

const PRODUCT_COLUMNS =
  "id, sku, barcode, name_ar, name_en, description_ar, description_en, brand_id, main_category, price, image_url, approval, platform_status";
const VARIANT_COLUMNS = "parent_product_id";
const PAGE_SIZE = 1000;
const MAX_PRODUCTS = 20000;

async function readAllRows(builder: RangeBuilder, cap: number): Promise<{ rows: unknown[]; partial: boolean }> {
  const rows: unknown[] = [];
  for (let from = 0; from < cap; from += PAGE_SIZE) {
    const to = Math.min(from + PAGE_SIZE, cap) - 1;
    const { data, error } = await builder.range(from, to);
    if (error) throw new Error("read_failed");
    const page = Array.isArray(data) ? data : [];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return { rows, partial: false };
  }
  return { rows, partial: true };
}

export interface OperationsDashboardData {
  items: OperationsListItem[];
  readiness: ProductReadiness[];
  tasks: OperationTask[];
  buckets: NewProductBuckets;
  health: HealthSummary;
  partial: boolean;
  /** true when a trusted Shopify read succeeded; false = degraded (unknown) */
  shopifyAvailable: boolean;
}

export type OperationsLoadResult =
  | { status: "ok"; data: OperationsDashboardData }
  | { status: "error" };

/**
 * Load and compute the whole operations dashboard payload. Reads Malikas via
 * the session client; reads Shopify presence best-effort (failure → degraded,
 * never "missing"). Returns a single constant error status on any Malikas
 * failure — never a raw DB error.
 */
export async function loadOperationsDashboard(
  client: OperationsReadClient,
  deps?: { engines?: OperationsEngines; shopify?: ShopifyPresenceReader },
): Promise<OperationsLoadResult> {
  try {
    const engines = deps?.engines ?? (await defaultEngines());

    const products = await readAllRows(client.from("products").select(PRODUCT_COLUMNS).order("id", { ascending: true }), MAX_PRODUCTS);
    const variants = await readAllRows(
      client.from("product_variants").select(VARIANT_COLUMNS).order("parent_product_id", { ascending: true }),
      MAX_PRODUCTS,
    );

    // variant counts per parent — pure aggregation, no stock/PII read.
    const variantCounts = new Map<string, number>();
    for (const v of variants.rows) {
      const parent = (v as { parent_product_id?: unknown }).parent_product_id;
      if (typeof parent === "string" && parent !== "") variantCounts.set(parent, (variantCounts.get(parent) ?? 0) + 1);
    }

    // Shopify presence, best-effort. Any failure → unknown (degraded), never a guess.
    let shopifyAvailable = false;
    let shopifyById = new Map<string, PlatformPresence>();
    if (deps?.shopify) {
      try {
        const res = await deps.shopify.loadShopifyPresence(client);
        shopifyAvailable = res.available;
        shopifyById = res.byProductId;
      } catch {
        shopifyAvailable = false;
        shopifyById = new Map();
      }
    }

    const items: OperationsListItem[] = [];
    const readiness: ProductReadiness[] = [];
    const tasks: OperationTask[] = [];

    for (const raw of products.rows) {
      if (raw === null || typeof raw !== "object") continue;
      const row = raw as Record<string, unknown>;
      const id = typeof row.id === "string" ? row.id : "";
      if (id === "") continue;
      const presence = shopifyAvailable && shopifyById.has(id) ? { shopify: shopifyById.get(id)! } : undefined;
      const product = engines.mapProductRow(row, variantCounts.get(id) ?? 0, presence);
      const r = engines.computeProductReadiness(product);
      const statuses = engines.computePlatformStatuses(product, r.readyToPublish);
      const t = engines.generateProductTasks(product, r, statuses);
      readiness.push(r);
      tasks.push(...t);
      items.push(engines.toListItem(product, r, t, statuses));
    }

    return {
      status: "ok",
      data: {
        items,
        readiness,
        tasks,
        buckets: engines.classifyNewProducts(readiness),
        health: engines.computeHealthSummary(readiness, tasks),
        partial: products.partial || variants.partial,
        shopifyAvailable,
      },
    };
  } catch {
    return { status: "error" };
  }
}
