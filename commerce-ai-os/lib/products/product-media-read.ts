import "server-only";
// Server-only READ layer for product media (UX.4C-1).
//
// Loads ONE product's primary pointer + gallery, then projects them through the
// pure reducer. It creates no client (one is INJECTED from the page, session-
// scoped), uses NO service role, performs NO write / RPC / storage mutation, and
// never surfaces a raw database error. Reads are a whitelisted column set only
// (never select("*")) and the gallery read is bounded.
//
// Failure contract mirrors master-catalog-read.ts: a small result object, never
// a thrown raw error and never raw database text. A products-read failure fails
// closed (status "error"); a product_images-read failure is NON-fatal — the
// primary still comes from products.image_url.

import type { ProductMediaState } from "./product-media.ts";
import { EMPTY_PRODUCT_MEDIA } from "./product-media.ts";

/** Injectable pure reducer (tests pass the real one; default is lazy-loaded from
 *  the same relative module so node:test never resolves an extensionless value
 *  import at load time). */
export interface ProductMediaReducer {
  toProductMediaState(
    imageUrl: string | null | undefined,
    imageFilename: string | null | undefined,
    rows: readonly unknown[],
  ): ProductMediaState;
}

async function defaultReducer(): Promise<ProductMediaReducer> {
  const m = await import("./product-media.ts");
  return { toProductMediaState: m.toProductMediaState };
}

// ── Minimal Supabase-like read surface (only what this reader needs) ─────────
// Generic `.filter(col, op, val)` (not `.eq`) to keep the real client's
// structural typing from instantiating too deeply — same choice as the catalog
// detail reader.
interface MediaQueryResult {
  data: unknown[] | null;
  error: unknown | null;
}
interface MediaFilterBuilder extends PromiseLike<MediaQueryResult> {
  filter(column: string, operator: string, value: string): MediaFilterBuilder;
  limit(count: number): MediaFilterBuilder;
}
interface MediaSelectBuilder {
  select(columns: string): MediaFilterBuilder;
}
export interface ProductMediaReadClient {
  from(table: string): MediaSelectBuilder;
}

const PRODUCT_COLUMNS = "image_url, image_filename";
const IMAGE_COLUMNS = "id, url, filename, is_primary, sort_order";

const PRODUCT_LIMIT = 1;
/** A product's gallery is small; bounded defensively so a pathological row count
 *  can never hang the page. */
const IMAGE_LIMIT = 200;
const MAX_ID_LENGTH = 200;

export interface LoadProductMediaResult {
  status: "ok" | "error";
  state: ProductMediaState;
}

export interface LoadProductMediaOptions {
  /** Inject the pure reducer (tests). Defaults to the real module. */
  reduce?: ProductMediaReducer;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A read is successful only when error === null AND data is a real array. */
async function readByEq(
  client: ProductMediaReadClient,
  table: string,
  columns: string,
  column: string,
  value: string,
  limit: number,
): Promise<{ ok: boolean; rows: unknown[] }> {
  try {
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
 * Load one product's media state by product id.
 * - An invalid id → safe empty state (status "ok"), no query.
 * - A products-read failure → status "error", empty state (never a false empty).
 * - A missing product → status "ok", empty state.
 * - A product_images-read failure is NON-fatal: the primary still comes from
 *   products.image_url; the gallery is simply the primary alone.
 * The id is used ONLY as a parameterized .eq value — never interpolated.
 */
export async function loadProductMedia(
  client: ProductMediaReadClient,
  id: unknown,
  options?: LoadProductMediaOptions,
): Promise<LoadProductMediaResult> {
  if (typeof id !== "string" || id.trim().length === 0 || id.length > MAX_ID_LENGTH) {
    return { status: "ok", state: EMPTY_PRODUCT_MEDIA };
  }

  const reducer = options?.reduce ?? (await defaultReducer());

  const productRead = await readByEq(client, "products", PRODUCT_COLUMNS, "id", id, PRODUCT_LIMIT);
  if (!productRead.ok) {
    return { status: "error", state: EMPTY_PRODUCT_MEDIA };
  }
  if (productRead.rows.length === 0) {
    return { status: "ok", state: EMPTY_PRODUCT_MEDIA };
  }

  const productRow = isPlainObject(productRead.rows[0]) ? productRead.rows[0] : {};
  const imageUrl = typeof productRow.image_url === "string" ? productRow.image_url : null;
  const imageFilename = typeof productRow.image_filename === "string" ? productRow.image_filename : null;

  // Gallery read is best-effort: on failure we still project from image_url.
  const imageRead = await readByEq(client, "product_images", IMAGE_COLUMNS, "product_id", id, IMAGE_LIMIT);
  const rows = imageRead.ok ? imageRead.rows : [];

  const state = reducer.toProductMediaState(imageUrl, imageFilename, rows);
  return { status: "ok", state };
}
