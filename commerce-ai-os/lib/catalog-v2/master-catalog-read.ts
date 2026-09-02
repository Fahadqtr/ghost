import "server-only";
// Read-only Master Catalog DATA LAYER (Malikas V2, Phase UI.1).
//
// A SERVER-ONLY reader that SELECTs an explicit, catalog-only column whitelist
// from the existing `products` and `product_variants` tables (a temporary source
// until the V2 catalog schema exists), then projects rows through the pure view
// layer. It creates no client (one is passed in from the page), performs no
// write / RPC / external call, reads no inventory/platform/order table, and
// never surfaces a raw database error. Reads are capped; if the cap is hit the
// result is explicitly marked partial rather than claiming completeness.
//
// Catalog MEMBERSHIP is scoped to the active Snoonu Malikas master: the catalog
// shows exactly those products that hold an ACTIVE `snoonu:malikas` row in
// `external_channel_listings`. That membership is derived at read time from the
// listing table — never a hardcoded count — and it is the ONLY reason this
// reader touches a channel table: it selects `product_id` alone and reads no
// external id, no mapping metadata and no other storefront's data. Products
// outside the master are hidden from the catalog view only; nothing is deleted,
// archived or modified anywhere.

// The pure view layer is referenced by a relative import. Its TYPE is imported
// statically (erased at runtime → node:test can load this file); the pure
// PROJECTOR is injectable and, when not injected, is loaded lazily from the SAME
// relative module. Tests inject the real projector so no extensionless value
// import is resolved at test time.
import type { CatalogVariant, MasterCatalogProduct } from "./master-catalog-view";

export interface CatalogProjector {
  projectCatalogRows(productRows: readonly unknown[], variantRows: readonly unknown[]): MasterCatalogProduct[];
}

/** Lazily bind the real pure projector from the relative view module. */
async function defaultProjector(): Promise<CatalogProjector> {
  const m = await import("./master-catalog-view");
  return { projectCatalogRows: m.projectCatalogRows };
}

export interface CatalogDetailProjector {
  projectCatalogRows(productRows: readonly unknown[], variantRows: readonly unknown[]): MasterCatalogProduct[];
  projectCatalogVariants(variantRows: readonly unknown[]): CatalogVariant[];
}

/** Lazily bind the real detail projector (single product + its variants). */
async function defaultDetailProjector(): Promise<CatalogDetailProjector> {
  const m = await import("./master-catalog-view");
  return { projectCatalogRows: m.projectCatalogRows, projectCatalogVariants: m.projectCatalogVariants };
}

// ── Minimal Supabase-like read surface (only what this reader needs) ─────────

export interface CatalogQueryResult {
  data: unknown[] | null;
  error: unknown | null;
}
export interface CatalogRangeBuilder extends PromiseLike<CatalogQueryResult> {
  order(column: string, options: { ascending: boolean }): CatalogRangeBuilder;
  range(from: number, to: number): CatalogRangeBuilder;
  // Generic parameterized filter (same reason as the detail surface below: `.eq`
  // derives its value type from the row generic and instantiates too deeply).
  // Used only to scope the membership read; values are bound, never interpolated.
  filter(column: string, operator: string, value: string): CatalogRangeBuilder;
}
export interface CatalogSelectBuilder {
  select(columns: string): CatalogRangeBuilder;
}
export interface CatalogReadClient {
  from(table: string): CatalogSelectBuilder;
}

// Detail reads use a separate minimal filter surface (select → filter → limit)
// kept deliberately small. We use PostgREST's generic `.filter(col, op, val)`
// rather than `.eq` because `.eq`'s value type derives from the row generic and
// makes the real Supabase client's structural assignment instantiate too deeply.
export interface CatalogDetailFilterBuilder extends PromiseLike<CatalogQueryResult> {
  filter(column: string, operator: string, value: string): CatalogDetailFilterBuilder;
  limit(count: number): CatalogDetailFilterBuilder;
}
export interface CatalogDetailSelectBuilder {
  select(columns: string): CatalogDetailFilterBuilder;
}
export interface CatalogDetailReadClient {
  from(table: string): CatalogDetailSelectBuilder;
}

// ── Explicit column whitelists (no *, no inventory/channel/platform/order) ───

const PRODUCT_COLUMNS = "id, sku, barcode, name_ar, name_en, price, discount_price, image_url, approval";
const VARIANT_COLUMNS = "parent_product_id";

// Membership read: `product_id` ONLY. No external id, no mapping metadata.
const LISTING_COLUMNS = "product_id";

// The storefront/status that define membership live in a shared pure module so
// this reader and the Home Dashboard cannot drift apart.
export { CATALOG_MAPPING_STATUS, CATALOG_STOREFRONT_KEY } from "./master-membership.ts";
import { CATALOG_MAPPING_STATUS, CATALOG_STOREFRONT_KEY } from "./master-membership.ts";

/** Fixed page size. Kept at/below the PostgREST default max-rows so no single
 *  response is silently truncated. Pagination reads every page until the source
 *  is proven exhausted (a page shorter than PAGE_SIZE) or the cap is exceeded. */
const PAGE_SIZE = 1000;

/** Safe row caps. Reading beyond a cap yields a clearly partial result. */
const PRODUCT_CAP = 5000;
const VARIANT_CAP = 20000;
const LISTING_CAP = 20000;

// Deterministic ordering per table: a primary column plus a UNIQUE tie-breaker
// (the primary key `id`) so pages never overlap and never skip. `id` is used only
// for ordering — it is not part of the projected output.
const PRODUCT_ORDER: readonly [string, string] = ["sku", "id"];
const VARIANT_ORDER: readonly [string, string] = ["parent_product_id", "id"];
const LISTING_ORDER: readonly [string, string] = ["product_id", "id"];

export interface MasterCatalogResult {
  status: "ok" | "error";
  products: MasterCatalogProduct[];
  partial: boolean;
}

export interface LoadMasterCatalogOptions {
  /** Inject the pure projector (tests). Defaults to the real view module. */
  project?: CatalogProjector;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

interface PagedRead {
  ok: boolean; // false if ANY page failed (partial pages are discarded)
  rows: unknown[]; // capped to `cap`
  capped: boolean; // true when the source has MORE than `cap` rows
}

/**
 * Read a table page-by-page with a deterministic order and a unique tie-breaker.
 * A read is successful only when EVERY page returns error === null AND a real
 * array. If any page fails, all rows accumulated in this attempt are discarded
 * and ok:false is returned (never a silently-partial success). The source is
 * only considered exhausted when a page shorter than PAGE_SIZE arrives; if the
 * accumulated rows exceed `cap`, the read stops and is marked capped.
 */
async function readAllPages(
  client: CatalogReadClient,
  table: string,
  columns: string,
  order: readonly [string, string],
  cap: number,
  filters: readonly (readonly [string, string])[] = [],
): Promise<PagedRead> {
  const acc: unknown[] = [];
  let offset = 0;
  // Bounded: acc grows by up to PAGE_SIZE per iteration, so the cap check ends
  // the loop after at most ceil(cap/PAGE_SIZE)+1 pages even if the server keeps
  // returning full pages.
  for (;;) {
    let res: unknown;
    try {
      let q = client.from(table).select(columns);
      for (const [column, value] of filters) q = q.filter(column, "eq", value);
      res = await q
        .order(order[0], { ascending: true })
        .order(order[1], { ascending: true })
        .range(offset, offset + PAGE_SIZE - 1);
    } catch {
      return { ok: false, rows: [], capped: false }; // never re-surface the raw error
    }
    if (!(isPlainObject(res) && res.error === null && Array.isArray(res.data))) {
      return { ok: false, rows: [], capped: false }; // any page failure fails the whole read
    }
    const page = res.data;
    for (const row of page) acc.push(row);

    if (acc.length > cap) {
      return { ok: true, rows: acc.slice(0, cap), capped: true };
    }
    if (page.length < PAGE_SIZE) {
      return { ok: true, rows: acc, capped: false }; // short page → source exhausted
    }
    offset += PAGE_SIZE;
  }
}

/**
 * Collect the set of product ids that are members of the active Snoonu Malikas
 * master. Only non-empty string `product_id` values count; anything malformed is
 * ignored rather than admitted.
 */
function membershipIds(rows: readonly unknown[]): Set<string> {
  const ids = new Set<string>();
  for (const row of rows) {
    if (!isPlainObject(row)) continue;
    const pid = row.product_id;
    if (typeof pid === "string" && pid.length > 0) ids.add(pid);
  }
  return ids;
}

/** Keep only product rows whose `id` is in the membership set. */
function scopeToMembership(rows: readonly unknown[], ids: ReadonlySet<string>): unknown[] {
  const out: unknown[] = [];
  for (const row of rows) {
    if (!isPlainObject(row)) continue;
    const id = row.id;
    if (typeof id === "string" && ids.has(id)) out.push(row);
  }
  return out;
}

/**
 * Load the Malikas master catalog, scoped to the ACTIVE `snoonu:malikas`
 * listings.
 *
 * Both the membership read and the `products` read are core sources: if either
 * fails, the whole read fails closed (status error, no products). Failing closed
 * matters for membership specifically — a silent fallback would render every
 * product in the table as though it belonged to the master, which is exactly the
 * wrong answer. A `product_variants` page failure stays non-fatal but its rows
 * are ALL discarded — products still render with variantCount 0 and the result
 * is marked partial, so partial counts are never shown as if complete.
 *
 * The returned product list is the single source every downstream view helper
 * (summary cards, filter, sort, pagination, search) operates on, so scoping here
 * scopes all of them consistently.
 */
export async function loadMasterCatalog(
  client: CatalogReadClient,
  options?: LoadMasterCatalogOptions,
): Promise<MasterCatalogResult> {
  const projector = options?.project ?? (await defaultProjector());

  const listingRead = await readAllPages(
    client,
    "external_channel_listings",
    LISTING_COLUMNS,
    LISTING_ORDER,
    LISTING_CAP,
    [
      ["storefront_key", CATALOG_STOREFRONT_KEY],
      ["mapping_status", CATALOG_MAPPING_STATUS],
    ],
  );
  if (!listingRead.ok) {
    return { status: "error", products: [], partial: false };
  }

  const productRead = await readAllPages(client, "products", PRODUCT_COLUMNS, PRODUCT_ORDER, PRODUCT_CAP);
  if (!productRead.ok) {
    return { status: "error", products: [], partial: false };
  }

  const variantRead = await readAllPages(client, "product_variants", VARIANT_COLUMNS, VARIANT_ORDER, VARIANT_CAP);

  const scopedRows = scopeToMembership(productRead.rows, membershipIds(listingRead.rows));
  const products = projector.projectCatalogRows(scopedRows, variantRead.ok ? variantRead.rows : []);
  const partial = productRead.capped || listingRead.capped || !variantRead.ok || variantRead.capped;

  return { status: "ok", products, partial };
}

// ── Single product detail (Phase UI.2B) ──────────────────────────────────────

// Variant detail whitelist. `parent_product_id` is read only so the projector can
// count variants for this product; it is NOT exposed by projectCatalogVariants.
// stock_quantity and any platform/order/PII fields are never selected.
const VARIANT_DETAIL_COLUMNS = "id, parent_product_id, variant_name, variant_name_en, sku, barcode, price";

const PRODUCT_DETAIL_LIMIT = 1;
const VARIANT_DETAIL_LIMIT = 500; // a product's variants are small; bounded defensively

const MAX_ID_LENGTH = 200;

export interface LoadCatalogProductResult {
  status: "ok" | "error";
  product: MasterCatalogProduct | null; // null with status "ok" = not found
  variants: CatalogVariant[];
}

export interface LoadCatalogProductOptions {
  /** Inject the detail projector (tests). Defaults to the real view module. */
  project?: CatalogDetailProjector;
}

/** A read is successful only when error === null AND data is a real array. */
async function readByEq(
  client: CatalogDetailReadClient,
  table: string,
  columns: string,
  column: string,
  value: string,
  limit: number,
): Promise<{ ok: boolean; rows: unknown[] }> {
  try {
    // Parameterized equality filter — the value is passed as a bound argument,
    // never interpolated into a query string.
    const res: unknown = await client.from(table).select(columns).filter(column, "eq", value).limit(limit);
    if (isPlainObject(res) && res.error === null && Array.isArray(res.data)) {
      return { ok: true, rows: res.data };
    }
    return { ok: false, rows: [] };
  } catch {
    return { ok: false, rows: [] }; // never re-surface the raw error
  }
}

/**
 * Load one catalog product by id plus its catalog-safe variants.
 * - An invalid id resolves to a safe not-found (product: null) without querying.
 * - A product read failure → status "error" (never a false not-found).
 * - A missing product → status "ok", product null.
 * - A variant read failure is NON-fatal: the product still returns with an empty
 *   variant list (and variantCount from the product read alone), details hidden.
 * The id is used ONLY as a parameterized .eq value — never interpolated.
 */
export async function loadCatalogProduct(
  client: CatalogDetailReadClient,
  id: unknown,
  options?: LoadCatalogProductOptions,
): Promise<LoadCatalogProductResult> {
  // Defensive re-validation (the page validates too): non-string / empty / too
  // long → safe not-found, no query.
  if (typeof id !== "string" || id.length === 0 || id.trim().length === 0 || id.length > MAX_ID_LENGTH) {
    return { status: "ok", product: null, variants: [] };
  }

  const projector = options?.project ?? (await defaultDetailProjector());

  const productRead = await readByEq(client, "products", PRODUCT_COLUMNS, "id", id, PRODUCT_DETAIL_LIMIT);
  if (!productRead.ok) {
    return { status: "error", product: null, variants: [] };
  }
  if (productRead.rows.length === 0) {
    return { status: "ok", product: null, variants: [] };
  }

  const variantRead = await readByEq(
    client,
    "product_variants",
    VARIANT_DETAIL_COLUMNS,
    "parent_product_id",
    id,
    VARIANT_DETAIL_LIMIT,
  );
  const variantRows = variantRead.ok ? variantRead.rows : [];

  // Project the single product (variantCount is derived from the variant rows,
  // which carry parent_product_id) and the catalog-safe variant list.
  const products = projector.projectCatalogRows([productRead.rows[0]], variantRows);
  const product = products[0] ?? null;
  if (product === null) {
    // The product row had a malformed/missing id → treat as not found.
    return { status: "ok", product: null, variants: [] };
  }
  const variants = projector.projectCatalogVariants(variantRows);

  return { status: "ok", product, variants };
}
