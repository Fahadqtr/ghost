import "server-only";
// CH.5 — external_channel_listings reader (SERVER-ONLY, READ-ONLY).
//
// Backs the durable resolver's read PORT. The client is injected and the surface
// is select/eq only — no insert/update/delete/upsert/rpc exists here, so this
// reader provably cannot write. It reads identity, never quantity.

import {
  type ExternalListingRecord,
  type IdentityType,
  type MappingStatus,
} from "./external-listing-identity.ts";
import { type ChannelKey } from "./channel-model.ts";
import { type ExternalListingReaderPort } from "./durable-identity-resolver.ts";

interface QueryResult { data: unknown[] | null; error: unknown | null }
interface FilterBuilder extends PromiseLike<QueryResult> {
  eq(column: string, value: string): FilterBuilder;
}
interface SelectBuilder { select(columns: string): FilterBuilder }
/** Minimal READ surface (structurally the Supabase session/admin client). */
export interface ExternalListingReadClient {
  from(table: string): SelectBuilder;
}

const TABLE = "external_channel_listings";
const COLS =
  "id, product_id, variant_id, variant_sku, channel_key, storefront_key, external_product_id, external_variant_id, exported_sku, exported_barcode, identity_type, mapping_status, metadata";

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

function toRecord(r: Record<string, unknown>): ExternalListingRecord {
  return {
    id: str(r.id) ?? undefined,
    productId: str(r.product_id) ?? "",
    variantId: str(r.variant_id),
    variantSku: str(r.variant_sku),
    channelKey: (str(r.channel_key) ?? "shopify") as ChannelKey,
    storefrontKey: str(r.storefront_key) ?? "",
    externalProductId: str(r.external_product_id),
    externalVariantId: str(r.external_variant_id),
    exportedSku: str(r.exported_sku),
    exportedBarcode: str(r.exported_barcode),
    identityType: (str(r.identity_type) ?? "shopify_gid") as IdentityType,
    mappingStatus: (str(r.mapping_status) ?? "active") as MappingStatus,
    metadata: (r.metadata && typeof r.metadata === "object" ? (r.metadata as Record<string, unknown>) : undefined),
  };
}

async function rows(b: PromiseLike<QueryResult>): Promise<ExternalListingRecord[]> {
  const { data, error } = await b;
  if (error || !Array.isArray(data)) return [];
  return data
    .filter((r): r is Record<string, unknown> => r !== null && typeof r === "object")
    .map(toRecord);
}

/** Build the read port over an injected client. Read-only by construction. */
export function createExternalListingReader(client: ExternalListingReadClient): ExternalListingReaderPort {
  return {
    byProduct: (productId) => rows(client.from(TABLE).select(COLS).eq("product_id", productId)),
    byExternalId: async (storefrontKey, externalProductId, externalVariantId) => {
      let q = client.from(TABLE).select(COLS).eq("storefront_key", storefrontKey);
      if (externalProductId) q = q.eq("external_product_id", externalProductId);
      const all = await rows(q);
      // variant handle narrows in-memory (keeps the read surface eq-only).
      return externalVariantId ? all.filter((r) => r.externalVariantId === externalVariantId) : all;
    },
    bySku: (storefrontKey, sku) =>
      rows(client.from(TABLE).select(COLS).eq("storefront_key", storefrontKey).eq("exported_sku", sku)),
    byClaimedExternalId: (storefrontKey, claimedExternalProductId) =>
      rows(
        client.from(TABLE).select(COLS)
          .eq("storefront_key", storefrontKey)
          .eq("mapping_status", "needs_review")
          // PostgREST JSON filter: metadata->>claimed_external_product_id = value
          .eq("metadata->>claimed_external_product_id", claimedExternalProductId),
      ),
  };
}
