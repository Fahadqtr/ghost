import "server-only";
import { availabilityFromInStock, normalizeAvailability, type AvailabilityState } from "./read.ts";

// Availability Engine (INV.2C) — the SOLE product-level availability writer.
//
// It writes ONLY products.stock_status. It NEVER writes any quantity/shelf/sold
// column (inventory.stock_quantity, product_variants.stock_quantity, shelf_stock,
// variant_shelf_stock, sold_quantity) and NEVER propagates to a channel
// (platform_status.availability, channel_products.channel_status, Shopify,
// Talabat) — channel propagation is INV.2D. Callers own auth, id resolution,
// and revalidation; the engine owns the write.

/** Minimal supabase-like surface the engine needs (admin or RLS client). */
export interface AvailabilityWriteClient {
  from(table: string): {
    update(values: Record<string, unknown>): {
      in(column: string, values: string[]): Promise<{ error: { message: string } | null }>;
    };
  };
}

export type AvailabilityWriteResult =
  | { ok: true; count: number }
  | { ok: false; count: number; error: string };

/**
 * Write an explicit availability state to products.stock_status for the given
 * product ids. Validates the state (only the two allowed values are accepted;
 * an unknown state is rejected, never coerced) and batches large id lists.
 */
export async function writeProductAvailability(
  client: AvailabilityWriteClient,
  productIds: Array<string | null | undefined>,
  state: AvailabilityState,
): Promise<AvailabilityWriteResult> {
  const valid = normalizeAvailability(state);
  if (!valid) return { ok: false, count: 0, error: `invalid availability state: ${String(state)}` };
  const ids = Array.from(new Set((productIds ?? []).map((s) => String(s ?? "").trim()).filter(Boolean)));
  if (ids.length === 0) return { ok: true, count: 0 };
  let count = 0;
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const { error } = await client.from("products").update({ stock_status: valid }).in("id", chunk);
    if (error) return { ok: false, count, error: error.message };
    count += chunk.length;
  }
  return { ok: true, count };
}

/** Convenience: set ONE product In / Out of stock. */
export async function setProductAvailabilityState(
  client: AvailabilityWriteClient,
  productId: string,
  inStock: boolean,
): Promise<AvailabilityWriteResult> {
  return writeProductAvailability(client, [productId], availabilityFromInStock(inStock));
}
