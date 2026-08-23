import "server-only";
// Read-only Shopify Catalog DATA LAYER (Malikas V2, Phase UI.3B).
//
// A SERVER-ONLY reader that (1) SELECTs an explicit, catalog-only column
// whitelist from the existing `products` and `product_variants` tables with real
// pagination, (2) calls the existing Shopify READ once to list every Shopify
// product, and (3) projects both through the pure view/matching layer into a
// PII-safe read model. It creates no client (the Supabase client is passed in),
// performs no write / RPC / mutation on either system, reads no
// inventory-stock / channel / order / customer field, and never surfaces a raw
// database error, Shopify error, token, or domain. Reads are capped; hitting a
// cap marks the result partial rather than claiming completeness.
//
// The pure view layer and the Shopify read client are referenced only by TYPE
// statically (erased at runtime → node:test can load this file); their runtime
// values are injectable and, when not injected, loaded lazily from their
// relative modules. Tests inject both so no server-only value import is resolved
// at test time.
import type {
  ShopifyCatalogRow,
  ShopifyOrphanVariant,
  ShopifyProductInput,
} from "./shopify-catalog-view";

export interface ShopifyCatalogProjector {
  projectShopifyCatalog(
    productRows: readonly unknown[],
    variantRows: readonly unknown[],
    shopifyProducts: readonly ShopifyProductInput[] | null,
  ): { rows: ShopifyCatalogRow[]; orphanVariants: ShopifyOrphanVariant[]; shopifyAvailable: boolean };
}

/** Lazily bind the real pure projector from the relative view module. */
async function defaultProjector(): Promise<ShopifyCatalogProjector> {
  const m = await import("./shopify-catalog-view");
  return { projectShopifyCatalog: m.projectShopifyCatalog };
}

/** The one Shopify READ this layer is allowed to call (list products). */
export interface ShopifyReader {
  fetchAllShopifyProducts(): Promise<{ products?: ShopifyProductInput[]; error?: string }>;
}

/** Lazily bind the real (server-only) Shopify read client. */
async function defaultShopifyReader(): Promise<ShopifyReader> {
  const m = await import("../shopify/admin");
  return { fetchAllShopifyProducts: m.fetchAllShopifyProducts };
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
//
// Only identity + display fields are read. stock_quantity and any
// platform/order/customer/PII column is never selected.
const PRODUCT_COLUMNS = "id, sku, barcode, name_ar, name_en, price, image_url";
const VARIANT_COLUMNS = "id, parent_product_id, sku, barcode, price";

/** Fixed page size at/below the PostgREST default max-rows so no single response
 *  is silently truncated. Pagination reads every page until the source is proven
 *  exhausted (a short page) or the cap is exceeded. */
const PAGE_SIZE = 1000;

/** Safe row caps. Reading beyond a cap yields a clearly partial result. */
const PRODUCT_CAP = 5000;
const VARIANT_CAP = 20000;

// Deterministic ordering per table: a primary column plus a UNIQUE tie-breaker
// (the primary key `id`) so pages never overlap and never skip. `id` is used
// only for ordering here — the projector decides what is exposed.
const PRODUCT_ORDER: readonly [string, string] = ["sku", "id"];
const VARIANT_ORDER: readonly [string, string] = ["parent_product_id", "id"];

// Why the Shopify read was unavailable — a CLASSIFIED, PII-safe category the
// UI maps to a fixed Arabic hint. Never the raw error / token / domain.
// Diagnosed in production 2026-08-23: the store was frozen by Shopify billing
// (authenticated Admin API rejected, storefront HTTP 402) and the operator saw
// only the generic banner — the reason was swallowed here. Classification keeps
// the fail-safe fallback while making the cause visible and actionable.
export type ShopifyUnavailableReason =
  | "not_configured" // SHOPIFY_STORE_DOMAIN missing on the server
  | "not_connected" // no OAuth token yet — install flow not completed
  | "store_unavailable" // Shopify refuses API access (frozen/paused store, billing)
  | "auth_rejected" // token present but rejected (revoked/expired)
  | "error"; // network/timeout/unexpected response

/** Pure classifier over the central client's FIXED error strings (admin.ts). */
export function classifyShopifyUnavailable(error: unknown): ShopifyUnavailableReason {
  const msg = typeof error === "string" ? error : "";
  if (msg.includes("SHOPIFY_STORE_DOMAIN")) return "not_configured";
  if (msg.includes("غير مربوط")) return "not_connected";
  if (/Shopify HTTP (402|403|423)/.test(msg) || /unavailable for API access|payment required/i.test(msg)) {
    return "store_unavailable";
  }
  if (/Shopify HTTP 401/.test(msg) || /invalid api key or access token/i.test(msg)) return "auth_rejected";
  return "error";
}

export type ShopifyCatalogReadResult =
  | {
      status: "ok";
      rows: ShopifyCatalogRow[];
      orphanVariants: ShopifyOrphanVariant[];
      partial: boolean;
      shopifyAvailable: true;
    }
  | {
      status: "shopify_unavailable";
      rows: ShopifyCatalogRow[];
      orphanVariants: [];
      partial: boolean;
      shopifyAvailable: false;
      /** classified cause — fixed category only, never raw error text */
      reason: ShopifyUnavailableReason;
    }
  | {
      status: "master_error";
      rows: [];
      orphanVariants: [];
      partial: false;
      shopifyAvailable: false;
    };

export interface LoadShopifyCatalogOptions {
  /** Inject the pure projector (tests). Defaults to the real view module. */
  project?: ShopifyCatalogProjector;
  /** Inject the Shopify reader (tests). Defaults to the real server client. */
  shopify?: ShopifyReader;
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
 * A read succeeds only when EVERY page returns error === null AND a real array;
 * any page failure discards all accumulated rows and returns ok:false (never a
 * silently-partial success). The source is exhausted only when a page shorter
 * than PAGE_SIZE arrives; exceeding `cap` stops the read and marks it capped.
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
 * Read every Shopify product ONCE, returning a normalized product list or null.
 * Returns null (never throws) on any Shopify error — a thrown exception, an
 * error field, or a missing product array — so a Shopify outage degrades to an
 * "unknown" read model rather than falsely marking the whole catalog missing.
 * The raw error / token / domain is never surfaced.
 */
async function readShopifyProducts(
  reader: ShopifyReader,
): Promise<{ products: readonly ShopifyProductInput[] } | { reason: ShopifyUnavailableReason }> {
  try {
    const res = await reader.fetchAllShopifyProducts();
    if (isPlainObject(res) && res.error === undefined && Array.isArray(res.products)) {
      return { products: res.products };
    }
    // The raw error string never leaves this module — only its category does.
    return { reason: classifyShopifyUnavailable(isPlainObject(res) ? res.error : undefined) };
  } catch {
    return { reason: "error" }; // never re-surface the raw Shopify error
  }
}

/**
 * Load the Malikas catalog joined LIVE to Shopify by identity.
 *
 * - `products` is the core source: any page failure fails closed
 *   (status "master_error", no rows).
 * - A `product_variants` page failure is non-fatal but ALL its rows are
 *   discarded and the result is marked partial (variant rows collapse to their
 *   parent product rows rather than showing partial counts as complete).
 * - The Shopify read runs exactly once. If it is unavailable the result is
 *   status "shopify_unavailable" with every row's presence/match set to
 *   "unknown" (never silently "missing") and no orphan list.
 */
export async function loadShopifyCatalog(
  client: CatalogReadClient,
  options?: LoadShopifyCatalogOptions,
): Promise<ShopifyCatalogReadResult> {
  const projector = options?.project ?? (await defaultProjector());

  const productRead = await readAllPages(client, "products", PRODUCT_COLUMNS, PRODUCT_ORDER, PRODUCT_CAP);
  if (!productRead.ok) {
    return { status: "master_error", rows: [], orphanVariants: [], partial: false, shopifyAvailable: false };
  }

  const variantRead = await readAllPages(client, "product_variants", VARIANT_COLUMNS, VARIANT_ORDER, VARIANT_CAP);
  const variantRows = variantRead.ok ? variantRead.rows : [];
  const partial = productRead.capped || !variantRead.ok || variantRead.capped;

  const reader = options?.shopify ?? (await defaultShopifyReader());
  const shopifyRead = await readShopifyProducts(reader);
  const shopifyProducts = "products" in shopifyRead ? shopifyRead.products : null;

  const projection = projector.projectShopifyCatalog(productRead.rows, variantRows, shopifyProducts);

  if (shopifyProducts === null || projection.shopifyAvailable === false) {
    return {
      status: "shopify_unavailable",
      rows: projection.rows,
      orphanVariants: [],
      partial,
      shopifyAvailable: false,
      reason: "reason" in shopifyRead ? shopifyRead.reason : "error",
    };
  }

  return {
    status: "ok",
    rows: projection.rows,
    orphanVariants: projection.orphanVariants,
    partial,
    shopifyAvailable: true,
  };
}
