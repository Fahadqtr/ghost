// Shelf-stock cleanup for FULL product deletion (Phase UI.3D.0).
//
// `variant_shelf_stock.variant_id` is a plain uuid with NO foreign key, so
// deleting a product's variants does not cascade to it and does not error — the
// shelf rows simply outlive the variants they describe. Both full-product
// delete paths must therefore clear them explicitly, BEFORE the variants go
// (once the variants are gone their ids can no longer be looked up).
//
// Deliberately NOT a "use server" module: every export of a "use server" file
// becomes a callable endpoint, and this is an internal helper, not an action.
//
// Scope: full product deletion only. Removing a single variant during an edit
// is handled atomically inside the sync_product_variants RPC, which refuses to
// delete a variant that still holds non-zero shelf quantity.

// PostgREST's generic `.filter(col, op, value)` is used rather than `.eq`/`.in`.
// Both are parameterized the same way on the wire, but `.eq`/`.in` derive their
// value type from the row generic, which makes the real Supabase client's
// structural assignment to this interface instantiate too deeply (TS2589).
interface ShelfCleanupClient {
  from(table: string): {
    select(columns: string): {
      filter(column: string, operator: string, value: string): PromiseLike<{ data: unknown[] | null; error: unknown }>;
    };
    delete(): {
      filter(column: string, operator: string, value: string): PromiseLike<{ error: unknown }>;
    };
  };
}

/** PostgREST `in` list syntax: (a,b,c) with each value quoted. */
function inList(values: readonly string[]): string {
  return `(${values.map((v) => `"${v.replace(/"/g, '""')}"`).join(",")})`;
}

export type ShelfCleanupResult = { ok: true; deletedVariantIds: number } | { ok: false };

/**
 * Delete every variant_shelf_stock row belonging to this product's variants.
 *
 * FAILS CLOSED. This is deliberately not best-effort: if the cleanup cannot be
 * proven to have succeeded and the caller deleted the variants anyway, the
 * shelf rows would be stranded pointing at ids that no longer exist — exactly
 * the orphaning this phase exists to eliminate. A caller that gets ok:false
 * must abort the whole deletion rather than continue.
 *
 * ok:false on a failed id read, a failed delete (the delete's own `error` is
 * checked, never ignored), or any thrown exception. A product with no variants
 * is ok:true with zero ids — there is nothing to strand.
 */
export async function deleteShelfStockForProduct(
  client: ShelfCleanupClient,
  productId: string,
): Promise<ShelfCleanupResult> {
  if (typeof productId !== "string" || productId.length === 0) return { ok: false };
  try {
    const { data, error } = await client
      .from("product_variants")
      .select("id")
      .filter("parent_product_id", "eq", productId);
    if (error) return { ok: false };

    const ids = (Array.isArray(data) ? data : [])
      .map((r) => (r as { id?: unknown }).id)
      .filter((v): v is string => typeof v === "string" && v.length > 0);
    if (ids.length === 0) return { ok: true, deletedVariantIds: 0 };

    const del = await client
      .from("variant_shelf_stock")
      .delete()
      .filter("variant_id", "in", inList(ids));
    if (del.error) return { ok: false };

    return { ok: true, deletedVariantIds: ids.length };
  } catch {
    return { ok: false };
  }
}
