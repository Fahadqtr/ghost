// createProductCore — the shared create path for the AI product creator
// (Phase UI.5), mirroring updateProductCore in lib/products/product-save.ts.
//
// All-or-nothing WITHOUT new SQL: Supabase's PostgREST cannot wrap three
// inserts in one transaction from the client, so the core compensates — if
// the inventory seed or the variant insert fails, everything already written
// (variants, inventory, the product row) is deleted again, best-effort but
// verified, and the caller gets ok:false with a stage. No partial product can
// silently survive: a failed compensation is reported as `cleanup: "failed"`
// so the caller can surface it instead of pretending the rollback happened.
//
// CLIENT-AGNOSTIC: the core never constructs a Supabase client — it operates on
// the injected ProductCreateClient. Authorization/RLS semantics are a property of
// whatever client the CALLER injects, not of this module: the V2 create/import
// flows inject the session client (so RLS applies), while server-only callers
// with no RLS session (e.g. Malak, which runs after its own writer allow-list +
// signed-token checks) inject the admin client. No RPC, and no framework/runtime
// imports — node:test loads this module directly; the only import is the pure,
// dependency-free inventory-seed sibling.

import { isValidSeedQuantity, computeVariantParentSeed } from "./inventory-seed.ts";

export interface CreateVariantRow {
  parent_product_id?: string; // set by the core after the product insert
  variant_name: string | null;
  variant_name_en: string | null;
  sku: string | null;
  barcode: string | null;
  color: string | null;
  size: string | null;
  price: number | null;
  stock_quantity: number | null;
}

type WriteError = { code?: string; message: string };

export interface ProductCreateClient {
  from(table: string): {
    insert(values: Record<string, unknown> | Record<string, unknown>[]): {
      select(columns: string): {
        single(): PromiseLike<{ data: Record<string, unknown> | null; error: WriteError | null }>;
      };
    } & PromiseLike<{ error: WriteError | null }>;
    delete(): {
      filter(column: string, operator: string, value: string): PromiseLike<{ error: unknown }>;
    };
  };
}

/** Optional knobs for a create. `seedQuantity` sets the inventory seed's
 *  stock_quantity independently of the product row (default: row.stock_quantity
 *  ?? 0), so a caller can seed inventory without adding stock_quantity to `row`. */
export interface CreateProductCoreOptions {
  seedQuantity?: number;
}

// INV.6B — the injected server-only inventory-INITIALIZATION adapter. The core no
// longer inserts inventory/variant rows itself (those direct writes are impossible
// after the strict ACL lockdown); it delegates all authoritative numeric/structural
// state to the atomic inv_initialize_product_state RPC via this callback (built
// from a service-role client — see lib/products/inventory-initializer.ts). Injected
// so the core stays DB-free-testable. `variants` carry NORMALIZED stock (blank → 0).
export type InitializeInventoryState = (args: {
  productId: string;
  simpleStock: number;
  variants: readonly CreateVariantRow[];
}) => Promise<{ ok: true } | { ok: false; reason: string; duplicateIdentity?: boolean }>;

export type CreateProductCoreResult =
  | { ok: true; productId: string }
  | {
      ok: false;
      stage: "invalid_seed" | "invalid_variant_stock" | "product_insert" | "inventory_insert" | "variant_insert";
      duplicateIdentity: boolean;
      cleanup: "not_needed" | "done" | "failed";
    };

/**
 * Insert product -> inventory seed -> variants (one batch). On any failure,
 * delete what was created in reverse order. `row` must already be projected
 * (toProductRow) and `variantRows` already shaped; the core never touches
 * text processing, uniqueness scanning, storage, or AI.
 */
export async function createProductCore(
  client: ProductCreateClient,
  row: Record<string, unknown>,
  variantRows: readonly CreateVariantRow[],
  initialize: InitializeInventoryState,
  opts?: CreateProductCoreOptions,
): Promise<CreateProductCoreResult> {
  // INV.6B — create-time stock AUTHORITY, validated in TS then applied ATOMICALLY
  // by the injected inv_initialize_product_state adapter. The core performs NO
  // direct inventory/variant write (impossible after the strict ACL lockdown); it
  // inserts only the product row and delegates all authoritative numeric/structural
  // state to `initialize`. The products.stock_quantity mirror stays RETIRED (INV.4E).
  //   VARIANT product → parent seed = Σ NORMALIZED variant stock (blank/null → 0);
  //     a malformed variant stock (negative/fractional/NaN/Infinity/overflow) FAILS
  //     CLOSED before any insert; the top-level/opts.seedQuantity is ignored.
  //   SIMPLE product  → the requested seed must be a valid non-negative int4.
  let simpleStock = 0;
  let initVariants: readonly CreateVariantRow[] = variantRows;
  if (variantRows.length > 0) {
    const parentSeed = computeVariantParentSeed(variantRows.map((v) => v.stock_quantity));
    if (!parentSeed.ok) {
      return { ok: false, stage: "invalid_variant_stock", duplicateIdentity: false, cleanup: "not_needed" };
    }
    initVariants = variantRows.map((v, i) => ({ ...v, stock_quantity: parentSeed.normalized[i] }));
  } else {
    simpleStock = opts?.seedQuantity ?? ((row.stock_quantity as number | null) ?? 0);
    if (!isValidSeedQuantity(simpleStock)) {
      return { ok: false, stage: "invalid_seed", duplicateIdentity: false, cleanup: "not_needed" };
    }
  }
  // stock_quantity is stripped so the frozen legacy mirror is never written.
  const { stock_quantity: _mirrorOmit, ...productRow } = row;

  const { data: product, error: productErr } = await client
    .from("products")
    .insert(productRow)
    .select("id")
    .single();
  const productId = typeof product?.id === "string" ? product.id : null;
  if (productErr || !productId) {
    return {
      ok: false,
      stage: "product_insert",
      duplicateIdentity: productErr?.code === "23505",
      cleanup: "not_needed",
    };
  }

  // INV.6A/6B — compensation deletes ONLY the just-created product row; the
  // auto-seed inventory row + any variant rows are removed by ON DELETE CASCADE.
  const rollback = async (): Promise<"done" | "failed"> => {
    try {
      const r = await client.from("products").delete().filter("id", "eq", productId);
      return r.error ? "failed" : "done";
    } catch {
      return "failed";
    }
  };

  // Atomic authoritative state via the injected service-role initializer (RPC).
  // No direct inventory/variant write here. Any failure rolls back the product
  // (FK cascade removes the auto-seed row). The RPC's classified reason maps to a
  // stage: invalid_seed / invalid_variant_stock are pre-checked above but also
  // re-mapped if the RPC re-classifies them; a variant-product structural failure
  // surfaces as variant_insert (so the caller shows the variant message), a simple
  // one as inventory_insert. A duplicate-identity signal (variant SKU/barcode
  // collision) is carried through so the caller can show the "already taken" copy.
  const init = await initialize({ productId, simpleStock, variants: initVariants });
  if (!init.ok) {
    const cleanup = await rollback();
    const isVariant = initVariants.length > 0;
    const stage = init.reason === "invalid_seed" ? "invalid_seed"
      : init.reason === "invalid_variant_stock" ? "invalid_variant_stock"
      : isVariant ? "variant_insert"
      : "inventory_insert";
    return { ok: false, stage, duplicateIdentity: init.duplicateIdentity === true, cleanup };
  }

  return { ok: true, productId };
}

/**
 * Project string form variants into insert rows — the same semantics as the
 * legacy toVariantRows (a row is meaningful when it has a name or a sku), but
 * pure and reusable. parent_product_id is left unset; the core stamps it.
 */
export function projectVariantInsertRows(
  variants: readonly {
    variant_name: string;
    variant_name_en: string;
    sku: string;
    barcode: string;
    color: string;
    size: string;
    price: string;
    stock_quantity: string;
  }[],
): CreateVariantRow[] {
  const str = (v: string) => {
    const t = (v ?? "").trim();
    return t === "" ? null : t;
  };
  const num = (v: string) => {
    const t = (v ?? "").trim();
    if (t === "") return null;
    const n = Number(t);
    return isNaN(n) ? null : n;
  };
  return variants
    .filter((v) => str(v.variant_name) || str(v.variant_name_en) || str(v.sku))
    .map((v) => ({
      variant_name: str(v.variant_name),
      variant_name_en: str(v.variant_name_en),
      sku: str(v.sku),
      barcode: str(v.barcode),
      color: str(v.color),
      size: str(v.size),
      price: num(v.price),
      stock_quantity: num(v.stock_quantity),
    }));
}
