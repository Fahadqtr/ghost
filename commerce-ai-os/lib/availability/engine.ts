import "server-only";
import { availabilityFromInStock, normalizeAvailability, type AvailabilityState } from "./read.ts";

// Availability Engine (INV.2C + INV.2E) — the SOLE availability writer.
//
// It writes ONLY the two explicit availability columns: products.stock_status
// (product-level) and product_variants.stock_status (variant-level, INV.2E). It
// NEVER writes any quantity/shelf/sold column (inventory.stock_quantity,
// product_variants.stock_quantity, shelf_stock, variant_shelf_stock,
// sold_quantity) and NEVER propagates to a channel (platform_status.availability,
// channel_products.channel_status, Shopify, Talabat) — channel propagation is
// INV.2D. Callers own auth, id resolution, and revalidation; the engine owns the
// write. Product and variant availability are separate fields — writing one never
// mutates the other.

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

/**
 * INV.2E — write an explicit availability state to product_variants.stock_status
 * for the given variant ids. Same contract as the product writer: validates the
 * state, batches, and writes ONLY the variant's stock_status (never its
 * stock_quantity). Writing a variant never touches the parent product.
 */
export async function writeVariantAvailability(
  client: AvailabilityWriteClient,
  variantIds: Array<string | null | undefined>,
  state: AvailabilityState,
): Promise<AvailabilityWriteResult> {
  const valid = normalizeAvailability(state);
  if (!valid) return { ok: false, count: 0, error: `invalid availability state: ${String(state)}` };
  const ids = Array.from(new Set((variantIds ?? []).map((s) => String(s ?? "").trim()).filter(Boolean)));
  if (ids.length === 0) return { ok: true, count: 0 };
  let count = 0;
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const { error } = await client.from("product_variants").update({ stock_status: valid }).in("id", chunk);
    if (error) return { ok: false, count, error: error.message };
    count += chunk.length;
  }
  return { ok: true, count };
}

/** Convenience: set ONE variant In / Out of stock. */
export async function setVariantAvailabilityState(
  client: AvailabilityWriteClient,
  variantId: string,
  inStock: boolean,
): Promise<AvailabilityWriteResult> {
  return writeVariantAvailability(client, [variantId], availabilityFromInStock(inStock));
}
