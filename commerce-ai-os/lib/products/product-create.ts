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
// Session-scoped client ONLY (RLS applies). No admin client, no RPC, and no
// framework/runtime imports — node:test loads this module directly. The only
// import is the pure, dependency-free inventory-seed sibling.

import { inventorySeed } from "./inventory-seed.ts";

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

export type CreateProductCoreResult =
  | { ok: true; productId: string }
  | {
      ok: false;
      stage: "product_insert" | "inventory_insert" | "variant_insert";
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
): Promise<CreateProductCoreResult> {
  const { data: product, error: productErr } = await client
    .from("products")
    .insert(row)
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

  const rollback = async (withInventory: boolean, withVariants: boolean): Promise<"done" | "failed"> => {
    let okAll = true;
    try {
      if (withVariants) {
        const r = await client.from("product_variants").delete().filter("parent_product_id", "eq", productId);
        if (r.error) okAll = false;
      }
      if (withInventory) {
        const r = await client.from("inventory").delete().filter("product_id", "eq", productId);
        if (r.error) okAll = false;
      }
      const r = await client.from("products").delete().filter("id", "eq", productId);
      if (r.error) okAll = false;
    } catch {
      okAll = false;
    }
    return okAll ? "done" : "failed";
  };

  const invErr = (
    await client.from("inventory").insert({
      product_id: productId,
      ...inventorySeed((row.stock_quantity as number | null) ?? 0),
    })
  ).error;
  if (invErr) {
    const cleanup = await rollback(false, false);
    return { ok: false, stage: "inventory_insert", duplicateIdentity: false, cleanup };
  }

  if (variantRows.length > 0) {
    const rows = variantRows.map((v) => ({ ...v, parent_product_id: productId }));
    const vErr = (await client.from("product_variants").insert(rows)).error;
    if (vErr) {
      const cleanup = await rollback(true, true);
      return {
        ok: false,
        stage: "variant_insert",
        duplicateIdentity: vErr?.code === "23505",
        cleanup,
      };
    }
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
