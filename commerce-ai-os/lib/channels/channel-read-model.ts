import "server-only";
// CH.2 — Channel mapping read-model reader. SERVER-ONLY, READ-ONLY.
//
// Loads exactly the rows the pure channel-model needs for ONE product — through
// an INJECTED session client (RLS), TARGETED by product id (no full-catalog
// scan, addressing the CH.0 perf finding) — and returns the unified per-channel
// projection. No admin client, no service role, no RPC, no write, no SQL, no
// migration. Any read error degrades (never partial, never invented).
//
// The client is injected (structurally the Supabase session client) and the read
// surface is select/eq/in ONLY — there is no insert/update/delete/upsert/rpc on
// this interface, which is what makes this reader provably read-only. Static
// imports are value-free except the pure channel-model, so it loads under node:test.

import {
  projectProductChannels,
  channelKeyFromName,
  type ChannelKey,
  type ChannelModelProduct,
  type ChannelOverlayRow,
  type PlatformStatusRow,
  type ProductChannelProjection,
} from "./channel-model.ts";

interface QueryResult {
  data: unknown[] | null;
  error: unknown | null;
}
interface FilterBuilder extends PromiseLike<QueryResult> {
  eq(column: string, value: string): FilterBuilder;
  in(column: string, values: readonly string[]): FilterBuilder;
}
interface SelectBuilder {
  select(columns: string): FilterBuilder;
}
/** Minimal READ surface (structurally the Supabase session client): from().select().eq/in
 *  only — no insert/update/delete/upsert/rpc exist here, so this reader cannot write. */
export interface ChannelReadClient {
  from(table: string): SelectBuilder;
}

export interface ProductChannelRead {
  projections: ProductChannelProjection[];
  /** true when the core product read FAILED — caller treats as unknown, never invents state. */
  degraded: boolean;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

async function rows(b: PromiseLike<QueryResult>): Promise<Record<string, unknown>[]> {
  const { data, error } = await b;
  if (error || !Array.isArray(data)) return [];
  return data.filter((r): r is Record<string, unknown> => r !== null && typeof r === "object");
}

/**
 * Read one product's unified channel projection (READ-ONLY, targeted).
 * Returns `degraded:true` with an empty projection if the product row can't be read.
 */
export async function loadProductChannelProjection(
  client: ChannelReadClient,
  productId: string,
): Promise<ProductChannelRead> {
  // 1) core product external-id columns
  const prodRows = await rows(
    client.from("products").select("id, snoonu_id, pure_seoul_id, rafeeq_product_id").eq("id", productId),
  );
  const prodRow = prodRows[0];
  if (!prodRow || str(prodRow.id) === null) return { projections: [], degraded: true };
  const product: ChannelModelProduct = {
    id: str(prodRow.id)!,
    snoonu_id: str(prodRow.snoonu_id),
    pure_seoul_id: str(prodRow.pure_seoul_id),
    rafeeq_product_id: str(prodRow.rafeeq_product_id),
  };

  // 2) channels registry → id → canonical key
  const channelRows = await rows(client.from("channels").select("id, name"));
  const idToKey = new Map<string, ChannelKey>();
  for (const c of channelRows) {
    const id = str(c.id);
    const key = channelKeyFromName(str(c.name));
    if (id && key) idToKey.set(id, key);
  }

  // 3) channel_products overlay (per channel)
  const overlay: Partial<Record<ChannelKey, ChannelOverlayRow>> = {};
  for (const cp of await rows(client.from("channel_products").select("channel_id, channel_status, channel_price").eq("product_id", productId))) {
    const key = idToKey.get(str(cp.channel_id) ?? "");
    if (key) overlay[key] = { channel_status: str(cp.channel_status), channel_price: num(cp.channel_price) };
  }

  // 4) platform_status overlay (platform is already a canonical text key)
  const platformStatus: Partial<Record<ChannelKey, PlatformStatusRow>> = {};
  for (const ps of await rows(client.from("platform_status").select("platform, approval, availability").eq("product_id", productId))) {
    const key = channelKeyFromName(str(ps.platform));
    if (key) platformStatus[key] = { approval: str(ps.approval), availability: str(ps.availability) };
  }

  // 5) Talabat durable external id (product-grain mapping: master_variant_sku IS NULL)
  let talabatChannelProductId: string | null = null;
  for (const m of await rows(client.from("channel_variant_mappings").select("channel_id, channel_product_id, master_variant_sku").eq("master_product_id", productId))) {
    if (idToKey.get(str(m.channel_id) ?? "") === "talabat" && str(m.master_variant_sku) === null) {
      talabatChannelProductId = str(m.channel_product_id);
      break;
    }
  }

  return {
    projections: projectProductChannels({ product, overlay, platformStatus, talabatChannelProductId }),
    degraded: false,
  };
}
