import "server-only";
// Catalog barcode write boundary (CH.6D).
//
// The SINGLE narrow writer for the barcode metadata column, mirroring the
// Availability Engine's shape: an injected minimal client, grain-exact, and it
// writes ONLY the `barcode` column — never stock/quantity, availability, images,
// or any other field. Product and variant grains are separate entry points so a
// variant barcode can never land on the parent product (or vice-versa). Callers
// own authorization (CH.3b requireMalakWriter) and id resolution; this module
// owns the write. It validates nothing about the barcode's shape — that is the
// caller's job via the canonical validators — it only refuses empty ids/values
// (this boundary completes missing barcodes; it never blanks one).

/** Minimal supabase-like surface: update ONE column, filtered by id. */
export interface BarcodeWriteClient {
  from(table: string): {
    update(values: Record<string, unknown>): {
      eq(column: string, value: string): Promise<{ error: { message: string } | null }>;
    };
  };
}

export type BarcodeWriteResult = { ok: true } | { ok: false; error: string };

const clean = (v: unknown): string => String(v ?? "").trim();

async function writeBarcode(
  client: BarcodeWriteClient,
  table: "products" | "product_variants",
  id: string,
  barcode: string,
): Promise<BarcodeWriteResult> {
  const rowId = clean(id);
  const bc = clean(barcode);
  if (!rowId) return { ok: false, error: "missing id" };
  if (!bc) return { ok: false, error: "refusing to write an empty barcode" };
  const { error } = await client.from(table).update({ barcode: bc }).eq("id", rowId);
  return error ? { ok: false, error: error.message } : { ok: true };
}

/** Write products.barcode for ONE simple product. Barcode column only. */
export function writeProductBarcode(client: BarcodeWriteClient, productId: string, barcode: string): Promise<BarcodeWriteResult> {
  return writeBarcode(client, "products", productId, barcode);
}

/** Write product_variants.barcode for ONE variant. Barcode column only. */
export function writeVariantBarcode(client: BarcodeWriteClient, variantId: string, barcode: string): Promise<BarcodeWriteResult> {
  return writeBarcode(client, "product_variants", variantId, barcode);
}
