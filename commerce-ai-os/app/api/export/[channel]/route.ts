import { createRequire } from "node:module";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireMalakWriter } from "@/lib/malak/authz";
import {
  buildSnoonuCsv, buildRafeeqAoa, RAFEEQ_COL_WIDTHS,
  CHANNEL_KEYS, type ChannelKey, type ExportProduct,
  type StatusMap,
} from "@/lib/exporters";
import {
  buildTalabatExport, talabatResultToCsv,
  isApprovedForTalabat, resolveExactChannelId, decideExportGate,
  type ExportProductInput, type ExportVariantInput, type PersistCounts,
} from "@/lib/talabat/export";
import { persistTalabatMappings, type MappingWriteClient } from "@/lib/talabat/persist-mappings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

export async function GET(
  req: Request,
  { params }: { params: Promise<{ channel: string }> }
) {
  const channel = (await params).channel as ChannelKey;
  if (!CHANNEL_KEYS.includes(channel)) {
    return new Response("Unknown channel", { status: 400 });
  }

  // INT.2E.2 — the legacy Shopify CSV export is FENCED. Shopify now publishes
  // through the new Export Center (/v2/export/shopify:malikas): ECL-identity-safe,
  // idempotent, and audited. This legacy path used fuzzy channel matching + legacy
  // id columns, so it must not be an operator entry point for Shopify. Other
  // channels (Snoonu/Talabat/Rafeeq) are untouched here (full retirement: INT.2F).
  if (channel === "shopify") {
    return new Response(
      "Shopify export moved to the Export Center: /v2/export/shopify:malikas",
      { status: 410, headers: { "Cache-Control": "no-store" } },
    );
  }

  const supabase = createClient();

  // Auth guard (middleware also gates this route).
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  try {
    // Products (all).
    const products = (await fetchAll((from, to) =>
      supabase
        .from("products")
        .select("id, sku, snoonu_id, rafeeq_product_id, barcode, name_en, name_ar, main_category, sub_category, product_type, price, discount_price, image_url, image_filename, notes, description_en, description_ar, keywords_en, keywords_ar, stock_status")
        .order("sku", { ascending: true })
        .range(from, to)
    )) as ExportProduct[];

    // Channel status map for this channel (Snoonu has 2 ids → same status).
    // Match channels by name pattern (the two Snoonu storefronts are now named
    // "Malika's Universe (Snoonu)" / "Pure Seoul (Snoonu)" — both contain "snoonu").
    const { data: chans } = await supabase
      .from("channels").select("id, name").ilike("name", `%${channel}%`);
    const chanIds = (chans ?? []).map((c: any) => c.id);
    const status: StatusMap = {};
    // Fuzzy status/price map for the OTHER channels (Snoonu deliberately spans
    // two storefronts). Talabat must NOT use this — it resolves its own exact
    // channel below so a "%talabat%" sibling (e.g. a "Talabat Archive" channel)
    // can never leak its price into the export.
    if (chanIds.length && channel !== "talabat") {
      const links = await fetchAll((from, to) =>
        supabase.from("channel_products")
          .select("product_id, channel_status")
          .in("channel_id", chanIds)
          .range(from, to)
      );
      for (const l of links) status[l.product_id] = l.channel_status ?? "Not Listed";
    }

    let csv: string;
    if (channel === "talabat") {
      // CH.3b — this branch persists channel_variant_mappings via the service-role
      // client (fail-closed: mappings MUST persist before any file downloads), so
      // it is a service-role mapping MUTATION → WRITER-only. Other channels below
      // are read-only CSV downloads and stay at signed-in level.
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
    } else if (channel === "snoonu") {
      csv = buildSnoonuCsv(products, status);
    } else {
      // Rafeeq → a formatted .xlsx (tidy column widths, bold header, autofilter).
      const require = createRequire(import.meta.url);
      const XLSX = require("xlsx");
      const aoa = buildRafeeqAoa(products);
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws["!cols"] = RAFEEQ_COL_WIDTHS.map((w) => ({ wch: w }));
      ws["!freeze"] = { xSplit: 0, ySplit: 1 };
      const range = XLSX.utils.decode_range(ws["!ref"]);
      ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: range.e.r, c: range.e.c } }) };
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Rafeeq");
      const buf: Buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
      const date = new Date().toISOString().slice(0, 10);
      return new Response(new Uint8Array(buf), {
        status: 200,
        headers: {
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="rafeeq_export_${date}.xlsx"`,
          "Cache-Control": "no-store",
        },
      });
    }

    const date = new Date().toISOString().slice(0, 10);
    return new Response("﻿" + csv, { // BOM so Arabic shows correctly in Excel
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${channel}_export_${date}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    // Talabat: never surface a raw error (message, Supabase/table/column names,
    // channel/product ids, SKU, or barcode). Any failure — products,
    // product_variants, platform_status, channels/channel_products, the admin
    // client, or persistence — collapses to one static, safe 503, and never a CSV.
    if (channel === "talabat") {
      return new Response("Talabat export is temporarily unavailable", { status: 503 });
    }
    return new Response(`Export failed: ${e instanceof Error ? e.message : "error"}`, { status: 500 });
  }
}
