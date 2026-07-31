// Loads the EXACT-Talabat-channel resolution context (mappings + products +
// variants) for the order resolver. Server-side data access is dependency-
// injected via an admin client (passed in), and the module imports only TYPES
// from its siblings (erased at runtime), so it stays self-contained and
// node:test can import it with a fake client. Fails CLOSED: a channel that does
// not resolve to exactly one Talabat channel → manual_review; any query error →
// error (no partial context).

import type { MappingSnapshot, ProductSnapshot, VariantSnapshot, ResolveContext } from "./order-resolver";

export type ChannelResolution =
  | { status: "ok"; id: string }
  | { status: "missing" }
  | { status: "ambiguous" };

/**
 * Resolve EXACTLY one Talabat channel by exact (case-insensitive) name. Never
 * picks the first of several and never uses a "%talabat%" sibling — 0 → missing,
 * >1 → ambiguous. Mirrors lib/talabat/export.ts resolveExactChannelId behavior.
 */
export function resolveExactTalabatChannel(channels: { id: string; name: string | null }[]): ChannelResolution {
  const want = "talabat";
  const matches = (channels ?? []).filter((c) => String(c.name ?? "").trim().toLowerCase() === want);
  if (matches.length === 0) return { status: "missing" };
  if (matches.length > 1) return { status: "ambiguous" };
  return { status: "ok", id: matches[0].id };
}

export function mapMappingRow(r: any): MappingSnapshot {
  return {
    channelProductId: r.channel_product_id ?? null,
    exportedSku: r.exported_sku ?? null,
    exportedBarcode: r.exported_barcode ?? null,
    masterProductId: r.master_product_id,
    masterVariantSku: r.master_variant_sku ?? null,
    mappingStatus: r.mapping_status,
  };
}
export function mapProductRow(r: any): ProductSnapshot {
  return { id: r.id, sku: r.sku ?? null, barcode: r.barcode ?? null, title: r.name_en ?? null };
}
export function mapVariantRow(r: any): VariantSnapshot {
  return { parentProductId: r.parent_product_id, sku: r.sku ?? null, barcode: r.barcode ?? null };
}

export type ContextResult =
  | { status: "ok"; channelId: string; context: ResolveContext }
  | { status: "manual_review"; reason: "talabat_channel_unresolved" }
  | { status: "error" };

const PAGE = 1000;

/**
 * Fetch every page of a range-based query. The catalogue is larger than one page,
 * so callers MUST paginate. Any query error throws (caller turns it into a
 * fail-closed error) — never a partial page set.
 */
async function fetchAllPages(run: (from: number, to: number) => Promise<{ data: any[] | null; error: any }>): Promise<any[]> {
  const out: any[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await run(from, from + PAGE - 1);
    if (error) throw new Error("query_error");
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

/**
 * Load the resolution context for the one exact Talabat channel. Mappings are
 * restricted to that channel id; products/variants are paginated in full. No
 * other channel's data is loaded.
 */
export async function loadTalabatResolutionContext(admin: any): Promise<ContextResult> {
  try {
    const { data: chans, error: chErr } = await admin.from("channels").select("id, name");
    if (chErr) return { status: "error" };
    const ch = resolveExactTalabatChannel(chans ?? []);
    if (ch.status !== "ok") return { status: "manual_review", reason: "talabat_channel_unresolved" };

    const mappingRows = await fetchAllPages((from, to) =>
      admin
        .from("channel_variant_mappings")
        .select("channel_product_id, exported_sku, exported_barcode, master_product_id, master_variant_sku, mapping_status")
        .eq("channel_id", ch.id)
        .range(from, to),
    );
    const productRows = await fetchAllPages((from, to) =>
      admin.from("products").select("id, sku, barcode, name_en").range(from, to),
    );
    const variantRows = await fetchAllPages((from, to) =>
      admin.from("product_variants").select("parent_product_id, sku, barcode").range(from, to),
    );

    const context: ResolveContext = {
      mappings: mappingRows.map(mapMappingRow),
      products: productRows.map(mapProductRow),
      variants: variantRows.map(mapVariantRow),
    };
    return { status: "ok", channelId: ch.id, context };
  } catch {
    return { status: "error" };
  }
}
