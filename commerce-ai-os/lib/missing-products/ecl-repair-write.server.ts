import "server-only";
// CH.6F — ECL mapping repair write boundary (SERVER-ONLY).
//
// The SINGLE narrow writer for creating a durable external_channel_listings row.
// INSERT-ONLY: it never UPDATEs, UPSERTs, or DELETEs, so it can never overwrite
// an active/conflicting mapping (§12) — a colliding row is rejected by the
// storefront-scoped unique indexes (23505) and reported as `duplicate`. It writes
// ONLY whitelisted identity columns and forces mapping_status = "active"; there
// is no stock/quantity column on this table by design (§2/§11). Callers own
// authorization (CH.3b) and the fresh pre-read (stale/duplicate protection).

/** Minimal insert-only surface. */
export interface EclWriteClient {
  from(table: string): {
    insert(values: Record<string, unknown>): PromiseLike<{ error: { message?: string; code?: string } | null }>;
  };
}

export interface EclMappingInput {
  productId: string;
  variantId: string | null;
  channelKey: string;
  storefrontKey: string;
  identityType: string;
  externalProductId: string | null;
  externalVariantId: string | null;
  exportedSku: string | null;
  exportedBarcode: string | null;
  variantSku: string | null;
}

export type EclWriteResult = { ok: true } | { ok: false; error: string; duplicate?: boolean };

const clean = (v: unknown): string | null => {
  const t = String(v ?? "").trim();
  return t === "" ? null : t;
};

/** The ONLY columns this boundary may write (no stock/quantity column exists). */
export const ECL_WRITE_COLUMNS = [
  "product_id",
  "variant_id",
  "variant_sku",
  "channel_key",
  "storefront_key",
  "external_product_id",
  "external_variant_id",
  "exported_sku",
  "exported_barcode",
  "identity_type",
  "mapping_status",
  "metadata",
] as const;

/**
 * Create one durable ECL mapping. INSERT-only. Requires an internal target, a
 * storefront + identity type, and at least one durable external identity
 * (external_product_id OR exported_sku). Never overwrites an existing row.
 */
export async function writeEclMapping(client: EclWriteClient, input: EclMappingInput, actor: string): Promise<EclWriteResult> {
  const productId = clean(input.productId);
  const storefrontKey = clean(input.storefrontKey);
  const channelKey = clean(input.channelKey);
  const identityType = clean(input.identityType);
  if (!productId || !storefrontKey || !channelKey || !identityType) {
    return { ok: false, error: "missing required identity fields" };
  }
  const externalProductId = clean(input.externalProductId);
  const exportedSku = clean(input.exportedSku);
  if (!externalProductId && !exportedSku) {
    return { ok: false, error: "no durable external identity to record" };
  }

  const row: Record<string, unknown> = {
    product_id: productId,
    variant_id: clean(input.variantId),
    variant_sku: clean(input.variantSku),
    channel_key: channelKey,
    storefront_key: storefrontKey,
    external_product_id: externalProductId,
    external_variant_id: clean(input.externalVariantId),
    exported_sku: exportedSku,
    exported_barcode: clean(input.exportedBarcode),
    identity_type: identityType,
    mapping_status: "active",
    metadata: { source: "ch6f_repair", created_by: actor },
  };

  const { error } = await client.from("external_channel_listings").insert(row);
  if (error) {
    if (String(error.code ?? "") === "23505") {
      return { ok: false, error: "a mapping already exists for this target/identity", duplicate: true };
    }
    return { ok: false, error: error.message ?? "insert failed" };
  }
  return { ok: true };
}
