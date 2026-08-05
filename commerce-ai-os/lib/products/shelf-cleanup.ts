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

/**
 * Delete every variant_shelf_stock row belonging to this product's variants.
 *
 * Best-effort by design: the caller is in the middle of an explicit, confirmed
 * product deletion, and a cleanup failure must not abort it and strand the
 * product half-deleted. Returns the number of variant ids it attempted to
 * clear, so callers/tests can assert it actually ran.
 */
export async function deleteShelfStockForProduct(
  client: ShelfCleanupClient,
  productId: string,
): Promise<number> {
  if (typeof productId !== "string" || productId.length === 0) return 0;
  try {
    const { data, error } = await client
      .from("product_variants")
      .select("id")
      .filter("parent_product_id", "eq", productId);
    if (error) return 0;

    const ids = (Array.isArray(data) ? data : [])
      .map((r) => (r as { id?: unknown }).id)
      .filter((v): v is string => typeof v === "string" && v.length > 0);
    if (ids.length === 0) return 0;

    await client.from("variant_shelf_stock").delete().filter("variant_id", "in", inList(ids));
    return ids.length;
  } catch {
    return 0; // never block an explicit product deletion
  }
}
