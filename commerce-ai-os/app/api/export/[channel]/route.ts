import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireMalakWriter } from "@/lib/malak/authz";
import {
  buildTalabatExport, talabatResultToCsv,
  isApprovedForTalabat, resolveExactChannelId, decideExportGate,
  type ExportProductInput, type ExportVariantInput, type PersistCounts,
} from "@/lib/talabat/export";
import { persistTalabatMappings, type MappingWriteClient } from "@/lib/talabat/persist-mappings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// INT.2F — Legacy export retirement.
//
// The legacy per-channel export platform is retired in favour of the Export
// Center (/v2/export). Shopify (INT.2E/2E.2), Snoonu (INT.2C) and Rafeeq
// (INT.2D) all have certified replacements, so those branches are FENCED here
// with a 410 that points operators to the new destination.
//
// The ONLY branch that remains live is `talabat`, and NOT for its CSV: it is the
// sole writer of `channel_variant_mappings` (the authoritative first rung of
// Talabat order-deduction identity, read by the Talabat webhook resolver). The
// certified Talabat package (INT.2B.2) is audit-only and does not persist those
// mappings, so this identity-persistence capability is UNREPLACED and must be
// retained until a dedicated mapping-sync phase re-homes it. Its logic is
// unchanged (fail-closed, exact-channel, writer-gated).

const PAGE = 1000;
async function fetchAll(q: (from: number, to: number) => any): Promise<any[]> {
  const out: any[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await q(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if ((data ?? []).length < PAGE) break;
  }
  return out;
}

// Legacy channels whose file export is replaced by the Export Center (/v2/export).
const RETIRED: Record<string, string> = {
  shopify: "/v2/export/shopify:malikas",
  snoonu: "/v2/export/snoonu:malikas",
  rafeeq: "/v2/export/rafeeq:malikas",
};

export async function GET(
  req: Request,
  { params }: { params: Promise<{ channel: string }> }
) {
  const channel = (await params).channel;

  // INT.2F — retired legacy exports return 410 and point to the Export Center.
  if (channel in RETIRED) {
    return new Response(
      `This export moved to the Export Center: ${RETIRED[channel]}`,
      { status: 410, headers: { "Cache-Control": "no-store" } },
    );
  }

  // Only Talabat remains — retained solely to persist channel_variant_mappings.
  if (channel !== "talabat") {
    return new Response("Unknown channel", { status: 400 });
  }

  const supabase = createClient();

  // Auth guard (middleware also gates this route).
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  try {
    // Products (all). Only the columns the Talabat flatten needs — NO legacy
    // per-store identity columns are read.
    const products = (await fetchAll((from, to) =>
      supabase
        .from("products")
        .select("id, sku, barcode, name_en, name_ar, main_category, price, discount_price, image_url, image_filename, notes, description_en, description_ar, stock_status")
        .order("sku", { ascending: true })
        .range(from, to)
    )) as any[];

    // Talabat channel candidates by name; the EXACT resolver picks exactly one
    // below (a fuzzy "%talabat%" sibling can never leak in).
    const { data: chans } = await supabase
      .from("channels").select("id, name").ilike("name", `%talabat%`);

    // CH.3b — this branch persists channel_variant_mappings via the service-role
    // client (fail-closed: mappings MUST persist before any file downloads), so
    // it is a service-role mapping MUTATION → WRITER-only.
    const writer = await requireMalakWriter();
    if (!writer.ok) return new Response("Forbidden", { status: 403 });
    // Flatten each variant into its own standalone Talabat product and persist
    // a channel_variant_mapping per VALID row. Blocked rows (missing SKU /
    // barcode / image, duplicates) are never exported.
    // Optional ?cats=A|B|C → include only those categories (default: all).
    // Optional ?source=new → only products added via Snoonu Sync (notes marker).
    const url2 = new URL(req.url);
    const catsParam = url2.searchParams.get("cats");
    let prods = products;
    if (url2.searchParams.get("source") === "new") {
      prods = prods.filter((p: any) => String(p.notes ?? "").startsWith("Imported from Snoonu sync"));
    }
    if (catsParam) {
      const want = new Set(catsParam.split("|").map((s) => s.trim()).filter(Boolean));
      prods = prods.filter((p) => want.has(String(p.main_category ?? "").trim()));
    }
    // Resolve EXACTLY ONE Talabat channel up front. Both the price override
    // and the mappings come only from this channel — never a fuzzy
    // "%talabat%" sibling.
    const channelRes = resolveExactChannelId(chans ?? [], "talabat");

    // Channel price override — ONLY from the exact Talabat channel, and only
    // when it resolves. Missing/ambiguous ⇒ no overrides are loaded.
    const talabatPrice: Record<string, number | null> = {};
    if (channelRes.status === "ok") {
      const links = await fetchAll((from, to) =>
        supabase.from("channel_products")
          .select("product_id, channel_price")
          .eq("channel_id", channelRes.id)
          .range(from, to)
      );
      for (const l of links) if (l.channel_price != null) talabatPrice[l.product_id] = l.channel_price;
    }

    const variants = (await fetchAll((from, to) =>
      supabase.from("product_variants")
        .select("parent_product_id, variant_name, variant_name_en, sku, barcode, price, stock_quantity, stock_status")
        .range(from, to)
    )) as any[];

    // Explicit Talabat approval lives in the per-platform overlay
    // (platform_status where platform='talabat'). A missing row / undefined /
    // any value other than "Approved" means NOT approved.
    const approvalByProduct: Record<string, string | null> = {};
    const approvals = await fetchAll((from, to) =>
      supabase.from("platform_status")
        .select("product_id, approval")
        .eq("platform", "talabat")
        .range(from, to)
    );
    for (const a of approvals) approvalByProduct[a.product_id] = a.approval ?? null;

    const productInputs: ExportProductInput[] = prods.map((p: any) => ({
      id: p.id, sku: p.sku, barcode: p.barcode,
      name_en: p.name_en, name_ar: p.name_ar,
      price: p.price, discount_price: p.discount_price,
      main_category: p.main_category,
      description_en: p.description_en, description_ar: p.description_ar,
      image_filename: p.image_filename, image_url: p.image_url,
      channel_price: talabatPrice[p.id] ?? null,          // exact Talabat channel only
      approved: isApprovedForTalabat(approvalByProduct[p.id]), // explicit approval only
      stock_status: p.stock_status ?? null,                // INV.2D explicit availability
    }));
    const variantInputs: ExportVariantInput[] = variants.map((v) => ({
      parent_product_id: v.parent_product_id, sku: v.sku, barcode: v.barcode,
      variant_name: v.variant_name, variant_name_en: v.variant_name_en,
      price: v.price, stock_quantity: v.stock_quantity,
      stock_status: v.stock_status ?? null, // INV.2E explicit variant availability
    }));

    const result = buildTalabatExport(productInputs, variantInputs);

    // FAIL-CLOSED: when there are valid rows, the Talabat channel must resolve
    // to exactly one AND every mapping must persist (failed === 0) before any
    // file may download. An unresolved/ambiguous channel, an admin/query
    // error, or any failed write returns a safe 503 — never a channel id,
    // product id, barcode, or raw DB error.
    let persist: PersistCounts | null = null;
    if (result.rows.length > 0 && channelRes.status === "ok") {
      try {
        const admin = createAdminClient() as unknown as MappingWriteClient;
        persist = await persistTalabatMappings(admin, channelRes.id, result.mappings, new Date().toISOString());
      } catch {
        persist = null; // treated as failure by the gate
      }
    }
    const gate = decideExportGate(result.rows.length, channelRes, persist);
    if (!gate.ok) return new Response(gate.message, { status: gate.httpStatus });

    const date = new Date().toISOString().slice(0, 10);
    return new Response("﻿" + talabatResultToCsv(result.rows), {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="talabat_export_${date}.csv"`,
        "Cache-Control": "no-store",
        "X-Talabat-Valid-Rows": String(result.rows.length),
        "X-Talabat-Blocked-Rows": String(result.blocked.length),
        "X-Talabat-Warnings": String(result.warnings.length),
      },
    });
  } catch {
    // Never surface a raw error (message, Supabase/table/column names,
    // channel/product ids, SKU, or barcode). Any failure collapses to one
    // static, safe 503, and never a CSV.
    return new Response("Talabat export is temporarily unavailable", { status: 503 });
  }
}
