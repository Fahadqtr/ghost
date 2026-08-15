import "server-only";
// CH.6A — Snoonu diagnostics reader (SERVER-ONLY, READ-ONLY).
//
// Fetches the rows the pure diagnostics compute needs (products + Snoonu ECL
// rows) through an injected client and returns per-storefront candidate counts.
// select-only surface — no insert/update/delete/upsert/rpc — so it provably
// cannot write. Reads identity, never quantity.

import {
  computeSnoonuDiagnostics,
  type SnoonuDiagProduct,
  type SnoonuDiagEclRow,
  type StorefrontDiagnostics,
} from "./snoonu-diagnostics.ts";
import { type MappingStatus } from "../../channels/external-listing-identity.ts";

interface QueryResult { data: unknown[] | null; error: unknown | null }
interface RangeBuilder extends PromiseLike<QueryResult> {
  eq(column: string, value: string): RangeBuilder;
  range(from: number, to: number): RangeBuilder;
}
interface SelectBuilder { select(columns: string): RangeBuilder }
export interface SnoonuDiagReadClient { from(table: string): SelectBuilder }

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

async function pageAll(make: (from: number, to: number) => PromiseLike<QueryResult>): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await make(from, from + 999);
    if (error || !Array.isArray(data)) break;
    out.push(...data.filter((r): r is Record<string, unknown> => r !== null && typeof r === "object"));
    if (data.length < 1000) break;
  }
  return out;
}

/** Read-only per-storefront Snoonu diagnostics (candidate counts only). */
export async function loadSnoonuDiagnostics(client: SnoonuDiagReadClient): Promise<StorefrontDiagnostics[]> {
  const productRows = await pageAll((from, to) =>
    client.from("products").select("id, sku, barcode, image_url, image_filename").range(from, to),
  );
  const products: SnoonuDiagProduct[] = productRows.map((r) => ({
    id: str(r.id) ?? "",
    sku: str(r.sku),
    barcode: str(r.barcode),
    hasImage: !!(str(r.image_url) || str(r.image_filename)),
  })).filter((p) => p.id);

  const eclRaw = await pageAll((from, to) =>
    client.from("external_channel_listings").select("product_id, storefront_key, external_product_id, mapping_status")
      .eq("channel_key", "snoonu").range(from, to),
  );
  const eclRows: SnoonuDiagEclRow[] = eclRaw.map((r) => ({
    productId: str(r.product_id) ?? "",
    storefrontKey: str(r.storefront_key) ?? "",
    spi: str(r.external_product_id),
    mappingStatus: (str(r.mapping_status) ?? "active") as MappingStatus,
  })).filter((r) => r.productId && r.storefrontKey);

  return computeSnoonuDiagnostics({ products, eclRows });
}
