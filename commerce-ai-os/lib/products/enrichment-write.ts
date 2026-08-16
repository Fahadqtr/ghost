import "server-only";
// CH.6E — Catalog enrichment metadata write boundary.
//
// The SINGLE narrow writer for AI-enriched metadata. It accepts ONLY the
// whitelisted enrichment columns (keywords/description, EN/AR) and writes one
// product row by id. Any other key is dropped — so identity, commerce, inventory,
// availability, image, barcode and channel fields can NEVER be written through
// this boundary, even if a caller passes them. Callers own authorization (CH.3b
// requireMalakWriter) and id resolution; this module owns the write.

/** The ONLY columns this boundary may write. */
export const ENRICHMENT_WRITE_COLUMNS = ["keywords_en", "keywords_ar", "description_en", "description_ar"] as const;
export type EnrichmentWriteColumn = (typeof ENRICHMENT_WRITE_COLUMNS)[number];

const ALLOWED = new Set<string>(ENRICHMENT_WRITE_COLUMNS);

/** Minimal supabase-like surface: update a product row by id. */
export interface EnrichmentWriteClient {
  from(table: "products"): {
    update(values: Record<string, unknown>): {
      eq(column: "id", value: string): Promise<{ error: { message: string } | null }>;
    };
  };
}

export type EnrichmentWriteResult = { ok: true } | { ok: false; error: string };

/**
 * Write enrichment metadata for ONE product. `patch` is filtered to the
 * whitelist; non-whitelisted keys and empty values are dropped. Refuses to write
 * a blank value (this boundary completes/improves content; it never clears it).
 */
export async function writeProductEnrichment(
  client: EnrichmentWriteClient,
  productId: string,
  patch: Partial<Record<EnrichmentWriteColumn, string>>,
): Promise<EnrichmentWriteResult> {
  const id = String(productId ?? "").trim();
  if (!id) return { ok: false, error: "missing product id" };

  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (!ALLOWED.has(k)) continue; // hard whitelist — drop anything else
    const val = String(v ?? "").trim();
    if (val === "") continue; // never blank a field through this boundary
    clean[k] = val;
  }
  if (Object.keys(clean).length === 0) return { ok: false, error: "no writable enrichment values" };

  const { error } = await client.from("products").update(clean).eq("id", id);
  return error ? { ok: false, error: error.message } : { ok: true };
}
