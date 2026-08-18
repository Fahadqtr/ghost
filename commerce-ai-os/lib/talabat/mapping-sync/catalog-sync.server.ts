import "server-only";
// INT.2F.2 — Talabat mapping catalog-sync (SERVER-ONLY).
//
// Re-homes the channel_variant_mappings persistence that used to live as a
// side-effect of the legacy Talabat CSV route (/api/export/[channel]). The legacy
// CSV output is retired; this preserves the ONLY thing that route did that had no
// certified replacement: writing the Talabat identity mappings (the authoritative
// first rung of order-deduction, read by lib/talabat/resolution-context).
//
// It is BEHAVIOR-IDENTICAL to the legacy mapping path:
//   • same bounded reads (products, exact Talabat channel, channel_products price
//     override, variants, platform_status approval),
//   • same candidate computation via buildTalabatExport(...).mappings over the
//     FULL valid catalog (same cardinality, same keys, same mapping_status),
//   • same exact-channel resolution (never a partial "%talabat%" sibling),
//   • same idempotent upsert + counts via the certified syncTalabatMappings
//     boundary (INT.2F.1) — persistTalabatMappings is NOT duplicated,
//   • same fail-closed gate semantics via decideExportGate.
//
// Authorization: callers own the writer gate (the package route runs
// requireMalakWriter before invoking this). It performs NO catalog / inventory /
// availability / lifecycle / ECL writes — the only write is the mapping upsert +
// the boundary's best-effort audit row. It NEVER throws.

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  buildTalabatExport, isApprovedForTalabat, resolveExactChannelId, decideExportGate,
  type ExportProductInput, type ExportVariantInput, type PersistCounts,
} from "@/lib/talabat/export";
import { syncTalabatMappings, type MappingSyncAdmin } from "@/lib/talabat/mapping-sync/mapping-sync.server";

const PAGE = 1000;

async function fetchAll(q: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: unknown }>): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await q(from, from + PAGE - 1);
    if (error) throw new Error("read failed");
    const rows = (data ?? []) as Record<string, unknown>[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

export interface CatalogSyncResult {
  /** true only when there were rows, the channel resolved, and failed === 0. */
  ok: boolean;
  counts: PersistCounts | null;
  /** exact-channel resolution status (never a partial sibling). */
  channelStatus: "ok" | "missing" | "ambiguous";
  validRows: number;
  blockedRows: number;
}

const EMPTY: CatalogSyncResult = { ok: false, counts: null, channelStatus: "missing", validRows: 0, blockedRows: 0 };

/**
 * Persist Talabat channel_variant_mappings for the FULL valid catalog. Writer
 * gate is owned by the caller. Never throws — a failure returns ok:false with the
 * best-known counts so the caller can surface it without failing the package.
 */
export async function syncTalabatMappingsFromCatalog(actor: string): Promise<CatalogSyncResult> {
  try {
    const supabase = createClient();

    // Products (all). Only the columns the Talabat flatten needs — NO legacy
    // per-store identity columns are read.
    const products = await fetchAll((from, to) =>
      supabase.from("products")
        .select("id, sku, barcode, name_en, name_ar, main_category, price, discount_price, image_url, image_filename, description_en, description_ar, stock_status")
        .order("sku", { ascending: true })
        .range(from, to));

    // Exact Talabat channel — a partial "%talabat%" sibling can never leak in.
    const { data: chans } = await supabase.from("channels").select("id, name").ilike("name", `%talabat%`);
    const channelRes = resolveExactChannelId((chans ?? []) as { id: string; name: string }[], "talabat");

    // Channel price override — ONLY from the exact Talabat channel when it resolves.
    const talabatPrice: Record<string, number | null> = {};
    if (channelRes.status === "ok") {
      const links = await fetchAll((from, to) =>
        supabase.from("channel_products").select("product_id, channel_price").eq("channel_id", channelRes.id).range(from, to));
      for (const l of links) if (l.channel_price != null) talabatPrice[String(l.product_id)] = l.channel_price as number;
    }

    const variants = await fetchAll((from, to) =>
      supabase.from("product_variants")
        .select("parent_product_id, variant_name, variant_name_en, sku, barcode, price, stock_quantity, stock_status")
        .range(from, to));

    // Explicit Talabat approval overlay (platform_status where platform='talabat').
    const approvalByProduct: Record<string, string | null> = {};
    const approvals = await fetchAll((from, to) =>
      supabase.from("platform_status").select("product_id, approval").eq("platform", "talabat").range(from, to));
    for (const a of approvals) approvalByProduct[String(a.product_id)] = (a.approval as string) ?? null;

    const productInputs: ExportProductInput[] = products.map((p) => ({
      id: p.id as string, sku: p.sku as string, barcode: p.barcode as string,
      name_en: p.name_en as string, name_ar: p.name_ar as string,
      price: p.price as number, discount_price: p.discount_price as number,
      main_category: p.main_category as string,
      description_en: p.description_en as string, description_ar: p.description_ar as string,
      image_filename: p.image_filename as string, image_url: p.image_url as string,
      channel_price: talabatPrice[p.id as string] ?? null,          // exact Talabat channel only
      approved: isApprovedForTalabat(approvalByProduct[p.id as string]), // explicit approval only
      stock_status: (p.stock_status as string) ?? null,             // INV.2D explicit availability
    }));
    const variantInputs: ExportVariantInput[] = variants.map((v) => ({
      parent_product_id: v.parent_product_id as string, sku: v.sku as string, barcode: v.barcode as string,
      variant_name: v.variant_name as string, variant_name_en: v.variant_name_en as string,
      price: v.price as number, stock_quantity: v.stock_quantity as number,
      stock_status: (v.stock_status as string) ?? null,             // INV.2E explicit variant availability
    }));

    // Same candidate computation as the legacy path — identical cardinality/keys.
    const result = buildTalabatExport(productInputs, variantInputs);

    let counts: PersistCounts | null = null;
    if (result.rows.length > 0 && channelRes.status === "ok") {
      const admin = createAdminClient() as unknown as MappingSyncAdmin;
      counts = await syncTalabatMappings(admin, channelRes.id, result.mappings, new Date().toISOString(), actor);
    }
    const gate = decideExportGate(result.rows.length, channelRes, counts);
    return {
      ok: gate.ok,
      counts,
      channelStatus: channelRes.status,
      validRows: result.rows.length,
      blockedRows: result.blocked.length,
    };
  } catch {
    return EMPTY;
  }
}
