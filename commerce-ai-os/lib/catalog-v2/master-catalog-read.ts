import "server-only";
// Read-only Master Catalog DATA LAYER (Malikas V2, Phase UI.1).
//
// A SERVER-ONLY reader that SELECTs an explicit, catalog-only column whitelist
// from the existing `products` and `product_variants` tables (a temporary source
// until the V2 catalog schema exists), then projects rows through the pure view
// layer. It creates no client (one is passed in from the page), performs no
// write / RPC / external call, reads no inventory/channel/platform/order table,
// and never surfaces a raw database error. Reads are capped; if the cap is hit
// the result is explicitly marked partial rather than claiming completeness.

// The pure view layer is referenced by a relative import. Its TYPE is imported
// statically (erased at runtime → node:test can load this file); the pure
// PROJECTOR is injectable and, when not injected, is loaded lazily from the SAME
// relative module. Tests inject the real projector so no extensionless value
// import is resolved at test time.
import type { MasterCatalogProduct } from "./master-catalog-view";

export interface CatalogProjector {
  projectCatalogRows(productRows: readonly unknown[], variantRows: readonly unknown[]): MasterCatalogProduct[];
}

/** Lazily bind the real pure projector from the relative view module. */
async function defaultProjector(): Promise<CatalogProjector> {
  const m = await import("./master-catalog-view");
  return { projectCatalogRows: m.projectCatalogRows };
}

// ── Minimal Supabase-like read surface (only what this reader needs) ─────────

export interface CatalogQueryResult {
  data: unknown[] | null;
  error: unknown | null;
}
export interface CatalogRangeBuilder extends PromiseLike<CatalogQueryResult> {
  order(column: string, options: { ascending: boolean }): CatalogRangeBuilder;
  range(from: number, to: number): CatalogRangeBuilder;
}
export interface CatalogSelectBuilder {
  select(columns: string): CatalogRangeBuilder;
}
export interface CatalogReadClient {
  from(table: string): CatalogSelectBuilder;
}

// ── Explicit column whitelists (no *, no inventory/channel/platform/order) ───

const PRODUCT_COLUMNS = "id, sku, barcode, name_ar, name_en, price, discount_price, image_url, approval";
const VARIANT_COLUMNS = "parent_product_id";

/** Fixed page size. Kept at/below the PostgREST default max-rows so no single
 *  response is silently truncated. Pagination reads every page until the source
 *  is proven exhausted (a page shorter than PAGE_SIZE) or the cap is exceeded. */
const PAGE_SIZE = 1000;

/** Safe row caps. Reading beyond a cap yields a clearly partial result. */
const PRODUCT_CAP = 5000;
const VARIANT_CAP = 20000;

// Deterministic ordering per table: a primary column plus a UNIQUE tie-breaker
// (the primary key `id`) so pages never overlap and never skip. `id` is used only
// for ordering — it is not part of the projected output.
const PRODUCT_ORDER: readonly [string, string] = ["sku", "id"];
const VARIANT_ORDER: readonly [string, string] = ["parent_product_id", "id"];

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
): Promise<PagedRead> {
  const acc: unknown[] = [];
  let offset = 0;
  // Bounded: acc grows by up to PAGE_SIZE per iteration, so the cap check ends
  // the loop after at most ceil(cap/PAGE_SIZE)+1 pages even if the server keeps
  // returning full pages.
  for (;;) {
    let res: unknown;
    try {
      res = await client
        .from(table)
        .select(columns)
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
 * Load the Malikas master catalog. `products` is the core source: if any page
 * fails, the whole read fails closed (status error, no products). A
 * `product_variants` page failure is non-fatal but its rows are ALL discarded —
 * products still render with variantCount 0 and the result is marked partial,
 * so partial counts are never shown as if complete.
 */
export async function loadMasterCatalog(
  client: CatalogReadClient,
  options?: LoadMasterCatalogOptions,
): Promise<MasterCatalogResult> {
  const projector = options?.project ?? (await defaultProjector());

  const productRead = await readAllPages(client, "products", PRODUCT_COLUMNS, PRODUCT_ORDER, PRODUCT_CAP);
  if (!productRead.ok) {
    return { status: "error", products: [], partial: false };
  }

  const variantRead = await readAllPages(client, "product_variants", VARIANT_COLUMNS, VARIANT_ORDER, VARIANT_CAP);

  const products = projector.projectCatalogRows(productRead.rows, variantRead.ok ? variantRead.rows : []);
  const partial = productRead.capped || !variantRead.ok || variantRead.capped;

  return { status: "ok", products, partial };
}
