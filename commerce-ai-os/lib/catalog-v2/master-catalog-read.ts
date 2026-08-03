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

import { projectCatalogRows, type MasterCatalogProduct } from "./master-catalog-view";

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

/** Safe row cap. Reading more than this returns a clearly partial result. */
const PRODUCT_CAP = 5000;
const VARIANT_CAP = 20000;

export interface MasterCatalogResult {
  status: "ok" | "error";
  products: MasterCatalogProduct[];
  partial: boolean;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A read is successful only when error === null AND data is a real array. */
async function readRows(
  client: CatalogReadClient,
  table: string,
  columns: string,
  orderColumn: string,
  cap: number,
): Promise<{ ok: boolean; rows: unknown[]; capped: boolean }> {
  try {
    const res: unknown = await client
      .from(table)
      .select(columns)
      .order(orderColumn, { ascending: true })
      .range(0, cap); // inclusive → up to cap + 1 rows, so overflow is detectable
    if (isPlainObject(res) && res.error === null && Array.isArray(res.data)) {
      const rows = res.data;
      const capped = rows.length > cap;
      return { ok: true, rows: capped ? rows.slice(0, cap) : rows, capped };
    }
    return { ok: false, rows: [], capped: false };
  } catch {
    return { ok: false, rows: [], capped: false }; // never re-surface the raw error
  }
}

/**
 * Load the Malikas master catalog. `products` is the core source: if it fails,
 * the whole read fails closed. A `product_variants` failure is non-fatal —
 * products still render (with zero variant counts) and the result is partial.
 */
export async function loadMasterCatalog(client: CatalogReadClient): Promise<MasterCatalogResult> {
  const productRead = await readRows(client, "products", PRODUCT_COLUMNS, "sku", PRODUCT_CAP);
  if (!productRead.ok) {
    return { status: "error", products: [], partial: false };
  }

  const variantRead = await readRows(client, "product_variants", VARIANT_COLUMNS, "parent_product_id", VARIANT_CAP);

  const products = projectCatalogRows(productRead.rows, variantRead.ok ? variantRead.rows : []);
  const partial = productRead.capped || !variantRead.ok || variantRead.capped;

  return { status: "ok", products, partial };
}
