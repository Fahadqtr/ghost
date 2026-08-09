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
  TimelineEvent,
  TimelineProductSnapshot,
} from "./shared/models";
import type { OperationsListItem } from "./dashboard-view";
import type { PureSoulState } from "@/lib/platforms/puresoul/capture-compute";
import type { TaskViewItem } from "./tasks-view";
import type { TimelineProvider } from "./timeline/providers/timeline-provider";

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
  flattenTasks(items: readonly OperationsListItem[]): TaskViewItem[];
}

async function defaultEngines(): Promise<OperationsEngines> {
  const [readiness, platforms, tasks, np, health, view, tasksView] = await Promise.all([
    import("./readiness/readiness"),
    import("./platforms/platform-status"),
    import("./tasks/task-engine"),
    import("./new-products/new-product-engine"),
    import("./health/health-engine"),
    import("./dashboard-view"),
    import("./tasks-view"),
  ]);
  return {
    computeProductReadiness: readiness.computeProductReadiness,
    computePlatformStatuses: platforms.computePlatformStatuses,
    generateProductTasks: tasks.generateProductTasks,
    classifyNewProducts: np.classifyNewProducts,
    computeHealthSummary: health.computeHealthSummary,
    toListItem: view.toListItem,
    mapProductRow: view.mapProductRow,
    flattenTasks: tasksView.flattenTasks,
  };
}

/** A Shopify presence reader (injected in tests; the UI.3 read model in prod). */
export interface ShopifyPresenceReader {
  loadShopifyPresence(
    client: OperationsReadClient,
  ): Promise<{ available: boolean; byProductId: Map<string, PlatformPresence> }>;
}

/** A Shopify SNAPSHOT reader (Phase UI.9.5): the persisted, per-product
 *  PlatformPresence reconstructed from platform_snapshots + freshness.
 *  Best-effort: `degraded` marks a read failure (→ reader fallback / unknown,
 *  never missing). Takes precedence over the live UI.3 presence when a product
 *  has a snapshot; falls back to the live reader otherwise. */
export interface ShopifySnapshotReader {
  loadShopifySnapshotView(client: OperationsReadClient): Promise<{
    available: boolean;
    degraded: boolean;
    byProductId: Map<string, PlatformPresence>;
    lastCapturedAt: string | null;
    stale: boolean;
  }>;
}

/** A PureSoul presence reader (injected in tests; the UI.9.1 overlay reader in
 *  prod). Best-effort: `degraded` marks a read failure (→ unknown, never
 *  missing); `available` marks a healthy read that carried PureSoul data. */
export interface PureSoulPresenceReader {
  loadPureSoulPresence(
    client: OperationsReadClient,
  ): Promise<{ available: boolean; degraded: boolean; byProductId: Map<string, PlatformPresence> }>;
}

/** A PureSoul SNAPSHOT reader (Phase UI.9.3): the persisted, classified state
 *  per product from platform_snapshots + freshness. Best-effort: `degraded`
 *  marks a read failure (→ unknown, never missing). Takes precedence over the
 *  live overlay when a product has a snapshot. */
export interface PureSoulSnapshotReader {
  loadPureSoulSnapshotView(client: OperationsReadClient): Promise<{
    available: boolean;
    degraded: boolean;
    byProductId: Map<string, PureSoulState>;
    lastCapturedAt: string | null;
    stale: boolean;
  }>;
}

/** Overlay presence (UI.9.1) → PureSoul dashboard state, used only as a fallback
 *  when a product has no persisted snapshot. The overlay can never yield
 *  missing / price_different — those come ONLY from a snapshot. */
function overlayToPureSoulState(p: PlatformPresence): PureSoulState | undefined {
  if (p.reviewRequired) return "review";
  if (p.live) return "published";
  if (p.linked) return "out_of_stock";
  return undefined;
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
  /** newest Shopify snapshot capture time, or null (never captured) */
  shopifyLastCapturedAt: string | null;
  /** true when the newest Shopify snapshot is older than the stale window (24h) */
  shopifyStale: boolean;
  /** true when a persisted Shopify snapshot read carried data */
  shopifySnapshotAvailable: boolean;
  /** true when a healthy PureSoul read (snapshot OR overlay) carried data */
  puresoulAvailable: boolean;
  /** true when a PureSoul read FAILED (show a degraded banner; never missing) */
  puresoulDegraded: boolean;
  /** newest PureSoul snapshot capture time, or null (never captured) */
  puresoulLastCapturedAt: string | null;
  /** true when the newest PureSoul snapshot is older than the stale window (24h) */
  puresoulStale: boolean;
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
  deps?: {
    engines?: OperationsEngines;
    shopify?: ShopifyPresenceReader;
    shopifySnapshot?: ShopifySnapshotReader;
    puresoul?: PureSoulPresenceReader;
    puresoulSnapshot?: PureSoulSnapshotReader;
  },
): Promise<OperationsLoadResult> {
  try {
    const engines = deps?.engines ?? (await defaultEngines());

    // These reads are independent — run them concurrently. A products or variants
    // read failure rejects (→ outer catch → constant error), exactly as before;
    // Shopify AND PureSoul presence stay BEST-EFFORT (their own failure degrades
    // to unknown and never fails the dashboard, never reports "missing").
    const emptyPresence = (): { available: boolean; byProductId: Map<string, PlatformPresence> } => ({
      available: false,
      byProductId: new Map<string, PlatformPresence>(),
    });
    const emptyPuresoul = (degraded: boolean) => ({
      available: false,
      degraded,
      byProductId: new Map<string, PlatformPresence>(),
    });
    const emptyPuresoulSnapshot = (degraded: boolean) => ({
      available: false,
      degraded,
      byProductId: new Map<string, PureSoulState>(),
      lastCapturedAt: null as string | null,
      stale: false,
    });
    const emptyShopifySnapshot = (degraded: boolean) => ({
      available: false,
      degraded,
      byProductId: new Map<string, PlatformPresence>(),
      lastCapturedAt: null as string | null,
      stale: false,
    });
    const [products, variants, shopifyRes, shopifySnapRes, puresoulRes, puresoulSnapRes] = await Promise.all([
      readAllRows(client.from("products").select(PRODUCT_COLUMNS).order("id", { ascending: true }), MAX_PRODUCTS),
      readAllRows(
        client.from("product_variants").select(VARIANT_COLUMNS).order("parent_product_id", { ascending: true }),
        MAX_PRODUCTS,
      ),
      deps?.shopify
        ? deps.shopify.loadShopifyPresence(client).then((r) => r, emptyPresence)
        : Promise.resolve(emptyPresence()),
      deps?.shopifySnapshot
        ? deps.shopifySnapshot.loadShopifySnapshotView(client).then((r) => r, () => emptyShopifySnapshot(true))
        : Promise.resolve(emptyShopifySnapshot(false)),
      deps?.puresoul
        ? deps.puresoul.loadPureSoulPresence(client).then((r) => r, () => emptyPuresoul(true))
        : Promise.resolve(emptyPuresoul(false)),
      deps?.puresoulSnapshot
        ? deps.puresoulSnapshot.loadPureSoulSnapshotView(client).then((r) => r, () => emptyPuresoulSnapshot(true))
        : Promise.resolve(emptyPuresoulSnapshot(false)),
    ]);

    // variant counts per parent — pure aggregation, no stock/PII read.
    const variantCounts = new Map<string, number>();
    for (const v of variants.rows) {
      const parent = (v as { parent_product_id?: unknown }).parent_product_id;
      if (typeof parent === "string" && parent !== "") variantCounts.set(parent, (variantCounts.get(parent) ?? 0) + 1);
    }

    // Shopify presence: a persisted snapshot (UI.9.5) takes precedence per
    // product; the live UI.3 reader is the fallback. "Available" for the engine
    // means EITHER source carried trusted data. Freshness comes from the snapshot.
    const shopifySnapById = shopifySnapRes.byProductId;
    const shopifyAvailable = shopifyRes.available || shopifySnapRes.available;
    const shopifyById = shopifyRes.byProductId;
    const shopifyLastCapturedAt = shopifySnapRes.lastCapturedAt;
    const shopifyStale = shopifySnapRes.stale;
    const shopifySnapshotAvailable = shopifySnapRes.available;
    const puresoulById = puresoulRes.byProductId;
    const puresoulSnapById = puresoulSnapRes.byProductId;
    // Snapshot OR overlay having data ⇒ connected; either read failing ⇒ degraded.
    const puresoulAvailable = puresoulSnapRes.available || puresoulRes.available;
    const puresoulDegraded = puresoulSnapRes.degraded || puresoulRes.degraded;
    const puresoulLastCapturedAt = puresoulSnapRes.lastCapturedAt;
    const puresoulStale = puresoulSnapRes.stale;

    const items: OperationsListItem[] = [];
    const readiness: ProductReadiness[] = [];
    const tasks: OperationTask[] = [];

    for (const raw of products.rows) {
      if (raw === null || typeof raw !== "object") continue;
      const row = raw as Record<string, unknown>;
      const id = typeof row.id === "string" ? row.id : "";
      if (id === "") continue;
      // Merge the per-product trusted platform snapshots (each omitted when
      // absent → the engine reports "unknown", never "missing").
      // Snapshot presence wins when present; else the live reader; else unknown.
      const shPres = shopifySnapById.has(id)
        ? shopifySnapById.get(id)
        : shopifyRes.available && shopifyById.has(id)
          ? shopifyById.get(id)
          : undefined;
      const psPres = puresoulById.has(id) ? puresoulById.get(id) : undefined;
      const presence =
        shPres || psPres
          ? { ...(shPres ? { shopify: shPres } : {}), ...(psPres ? { puresoul: psPres } : {}) }
          : undefined;
      const product = engines.mapProductRow(row, variantCounts.get(id) ?? 0, presence);
      const r = engines.computeProductReadiness(product);
      const statuses = engines.computePlatformStatuses(product, r.readyToPublish);
      const t = engines.generateProductTasks(product, r, statuses);
      readiness.push(r);
      tasks.push(...t);
      const listItem = engines.toListItem(product, r, t, statuses);
      // PureSoul state: persisted snapshot wins; else fall back to the live
      // overlay; else undefined (→ Unknown). Missing/price_different can only
      // come from a snapshot, never from the overlay or from absence.
      const puresoulState = puresoulSnapById.get(id) ?? (psPres ? overlayToPureSoulState(psPres) : undefined);
      if (puresoulState) listItem.puresoulState = puresoulState;
      items.push(listItem);
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
        shopifyLastCapturedAt,
        shopifyStale,
        shopifySnapshotAvailable,
        puresoulAvailable,
        puresoulDegraded,
        puresoulLastCapturedAt,
        puresoulStale,
      },
    };
  } catch {
    return { status: "error" };
  }
}

// ── Smart Tasks view (Phase UI.7.3) ──────────────────────────────────────────

export interface TasksViewData {
  tasks: TaskViewItem[];
  partial: boolean;
  shopifyAvailable: boolean;
}

export type TasksLoadResult = { status: "ok"; data: TasksViewData } | { status: "error" };

/**
 * Load the flat Smart-Tasks list. Reuses loadOperationsDashboard (single source
 * of the engine wiring) and flattens its per-product items into TaskViewItem[]
 * via the pure flattenTasks — no business logic here.
 */
export async function loadTasksView(
  client: OperationsReadClient,
  deps?: { engines?: OperationsEngines; shopify?: ShopifyPresenceReader },
): Promise<TasksLoadResult> {
  try {
    const engines = deps?.engines ?? (await defaultEngines());
    const dash = await loadOperationsDashboard(client, { ...deps, engines });
    if (dash.status !== "ok") return { status: "error" };
    return {
      status: "ok",
      data: {
        tasks: engines.flattenTasks(dash.data.items),
        partial: dash.data.partial,
        shopifyAvailable: dash.data.shopifyAvailable,
      },
    };
  } catch {
    return { status: "error" };
  }
}

// ── Single-product operations (Phase UI.7.3 detail widget) ───────────────────

export interface ProductOperations {
  tasks: OperationTask[];
  readinessPercent: number;
}

const PRODUCT_ONE_COLUMNS = PRODUCT_COLUMNS;

/**
 * Compute the operations tasks + readiness for ONE product, for the product
 * detail widget. Cheap single-product I/O via the session client. Shopify
 * presence is intentionally NOT read here (one product page must not trigger a
 * full Shopify catalog read); platform-publish tasks live on /v2/tasks. Returns
 * null on any failure — the widget then renders nothing, never a raw error.
 */
export async function loadProductOperations(
  client: OperationsReadClient,
  productId: string,
  deps?: { engines?: OperationsEngines },
): Promise<ProductOperations | null> {
  if (typeof productId !== "string" || productId === "") return null;
  try {
    const engines = deps?.engines ?? (await defaultEngines());
    const q = client.from("products").select(PRODUCT_ONE_COLUMNS).order("id", { ascending: true });
    const { rows } = await readAllRows(q, MAX_PRODUCTS);
    const raw = rows.find((r) => r !== null && typeof r === "object" && (r as { id?: unknown }).id === productId);
    if (!raw) return null;
    const row = raw as Record<string, unknown>;

    const vq = client.from("product_variants").select(VARIANT_COLUMNS).order("parent_product_id", { ascending: true });
    const variants = await readAllRows(vq, MAX_PRODUCTS);
    let variantCount = 0;
    for (const v of variants.rows) {
      if (v !== null && typeof v === "object" && (v as { parent_product_id?: unknown }).parent_product_id === productId) {
        variantCount++;
      }
    }

    const product = engines.mapProductRow(row, variantCount);
    const readiness = engines.computeProductReadiness(product);
    const statuses = engines.computePlatformStatuses(product, readiness.readyToPublish);
    const tasks = engines.generateProductTasks(product, readiness, statuses);
    return { tasks, readinessPercent: readiness.percent };
  } catch {
    return null;
  }
}

// ── Fast single-task re-derivation (perf; for the /v2/tasks TickTick actions) ─

const TASK_ID_MAX = 300;

/**
 * Re-derive ONE Smart-Tasks item by its OperationTask id, cheaply.
 *
 * The full loadTasksView rebuilds EVERY task and (via Shopify presence) fetches
 * the whole Shopify catalog just to find one task — the source of the 20–30s
 * preview/sync latency. The OperationTask id encodes its productId
 * (`<type>[:platform]:<productId>`), so this recomputes ONLY that product's
 * tasks with TARGETED reads and NO Shopify.
 *
 * Behavior-preserving: needs_review / needs_image / needs_data come purely from
 * readiness (the product row) and do NOT depend on Shopify presence — so any
 * item returned here is byte-identical to the full-dashboard version. Only
 * publish_platform tasks depend on Shopify; those (and unknown ids) are simply
 * not found here → the caller falls back to the full loadTasksView. Returns null
 * on not-found or ANY read failure (the caller then falls back).
 */
export async function loadTaskViewItem(
  client: ProductTimelineReadClient,
  operationTaskId: string,
  deps?: { engines?: OperationsEngines },
): Promise<TaskViewItem | null> {
  const id = typeof operationTaskId === "string" ? operationTaskId.trim() : "";
  if (id === "" || id.length > TASK_ID_MAX) return null;
  const productId = id.slice(id.lastIndexOf(":") + 1);
  if (productId === "" || productId.length > TASK_ID_MAX) return null;

  try {
    const engines = deps?.engines ?? (await defaultEngines());

    // Targeted single-product read (parameterized id equality, limit 1).
    let pRes: QueryResult;
    try {
      pRes = await client.from("products").select(PRODUCT_COLUMNS).filter("id", "eq", productId).limit(1);
    } catch {
      return null;
    }
    if (pRes.error !== null || !Array.isArray(pRes.data)) return null;
    const raw = pRes.data[0];
    if (raw === undefined || raw === null || typeof raw !== "object") return null;

    // Variant count for just this product (parameterized parent equality).
    let vRes: QueryResult;
    try {
      vRes = await client
        .from("product_variants")
        .select(VARIANT_COLUMNS)
        .filter("parent_product_id", "eq", productId)
        .limit(PAGE_SIZE);
    } catch {
      return null;
    }
    const variantCount = Array.isArray(vRes.data) ? vRes.data.length : 0;

    // NO Shopify presence → publish_platform tasks are intentionally absent here;
    // every OTHER task is Shopify-independent, so this matches the full path.
    const product = engines.mapProductRow(raw as Record<string, unknown>, variantCount);
    const readiness = engines.computeProductReadiness(product);
    const statuses = engines.computePlatformStatuses(product, readiness.readyToPublish);
    const tasks = engines.generateProductTasks(product, readiness, statuses);
    const listItem = engines.toListItem(product, readiness, tasks, statuses);
    return engines.flattenTasks([listItem]).find((it) => it.task.id === id) ?? null;
  } catch {
    return null;
  }
}

// ── Product Timeline (Phase UI.7.4) ──────────────────────────────────────────

// A minimal single-row filter surface (select → filter → limit), kept separate
// from the paged surface above. `.filter(col, op, val)` is a PARAMETERIZED
// PostgREST equality — the id is passed as a bound argument, never interpolated
// into a query string. Structurally satisfied by the real Supabase client.
interface TimelineFilterBuilder extends PromiseLike<QueryResult> {
  filter(column: string, operator: string, value: string): TimelineFilterBuilder;
  limit(count: number): TimelineFilterBuilder;
}
interface TimelineSelectBuilder {
  select(columns: string): TimelineFilterBuilder;
}
export interface ProductTimelineReadClient {
  from(table: string): TimelineSelectBuilder;
}

/**
 * The pure timeline layer (injected in tests; lazily bound in production). The
 * reader wires source PROVIDERS into the source-agnostic engine — it maps the
 * row into a snapshot, builds the snapshot provider, and asks the engine to
 * aggregate. Adding a future provider (TickTick, Shopify, …) means passing it
 * to buildTimeline here — the engine and this signature do not change.
 */
export interface TimelineEngines {
  mapSnapshotRow(row: Record<string, unknown>): TimelineProductSnapshot;
  createSnapshotTimelineProvider(snapshot: TimelineProductSnapshot): TimelineProvider;
  buildTimeline(providers: readonly TimelineProvider[]): TimelineEvent[];
}

async function defaultTimelineEngines(): Promise<TimelineEngines> {
  const [snapshotProvider, engine] = await Promise.all([
    import("./timeline/providers/snapshot-provider"),
    import("./timeline/timeline-engine"),
  ]);
  return {
    mapSnapshotRow: snapshotProvider.mapSnapshotRow,
    createSnapshotTimelineProvider: snapshotProvider.createSnapshotTimelineProvider,
    buildTimeline: engine.buildTimeline,
  };
}

// created_at / updated_at are needed here (and NOT in the paged reads above),
// so the timeline uses its own explicit whitelist. No stock/channel/order/PII.
const PRODUCT_TIMELINE_COLUMNS =
  "id, sku, barcode, name_ar, name_en, image_url, approval, platform_status, created_at, updated_at";
const TIMELINE_ID_MAX = 200;

export interface ProductTimelineData {
  snapshot: TimelineProductSnapshot;
  events: TimelineEvent[];
}

export type ProductTimelineResult =
  | { status: "ok"; timeline: ProductTimelineData }
  | { status: "notfound" }
  | { status: "error" };

/**
 * Load and compute the timeline for ONE product. A TARGETED single-row read
 * (parameterized id equality, limit 1) through the session client — RLS only,
 * no service role, no admin client, no write, no RPC. The snapshot provider
 * derives its events and the source-agnostic engine aggregates them; NO business
 * logic lives here. Returns a single constant error status on any read failure
 * (never a raw DB error), "notfound" for a valid id with no row, else "ok".
 */
export async function loadProductTimeline(
  client: ProductTimelineReadClient,
  productId: unknown,
  deps?: { engines?: TimelineEngines },
): Promise<ProductTimelineResult> {
  // Defensive id validation — non-string / empty / too long → safe not-found,
  // no query, and the value is never reflected anywhere.
  if (
    typeof productId !== "string" ||
    productId.length === 0 ||
    productId.trim().length === 0 ||
    productId.length > TIMELINE_ID_MAX
  ) {
    return { status: "notfound" };
  }

  try {
    const engines = deps?.engines ?? (await defaultTimelineEngines());
    let res: QueryResult;
    try {
      res = await client
        .from("products")
        .select(PRODUCT_TIMELINE_COLUMNS)
        .filter("id", "eq", productId)
        .limit(1);
    } catch {
      return { status: "error" }; // never re-surface the raw error
    }
    if (res.error !== null || !Array.isArray(res.data)) return { status: "error" };
    const raw = res.data[0];
    if (raw === undefined || raw === null || typeof raw !== "object") return { status: "notfound" };

    const snapshot = engines.mapSnapshotRow(raw as Record<string, unknown>);
    if (snapshot.id === "") return { status: "notfound" };
    const provider = engines.createSnapshotTimelineProvider(snapshot);
    const events = engines.buildTimeline([provider]);
    return { status: "ok", timeline: { snapshot, events } };
  } catch {
    return { status: "error" };
  }
}
