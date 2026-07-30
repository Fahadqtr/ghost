import { createRequire } from "node:module";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  buildShopifyCsv, buildSnoonuCsv, buildRafeeqAoa, RAFEEQ_COL_WIDTHS,
  CHANNEL_KEYS, type ChannelKey, type ExportProduct,
  type StatusMap,
} from "@/lib/exporters";
import {
  buildTalabatExport, talabatResultToCsv,
  type ExportProductInput, type ExportVariantInput,
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

  const supabase = createClient();

  // Auth guard (middleware also gates this route).
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  try {
    // Products (all).
    const products = (await fetchAll((from, to) =>
      supabase
        .from("products")
        .select("id, sku, snoonu_id, rafeeq_product_id, barcode, name_en, name_ar, main_category, sub_category, product_type, price, discount_price, image_url, image_filename, notes, description_en, description_ar, keywords_en, keywords_ar")
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
    const priceOverride: Record<string, number | null> = {};
    if (chanIds.length) {
      const links = await fetchAll((from, to) =>
        supabase.from("channel_products")
          .select("product_id, channel_status, channel_price")
          .in("channel_id", chanIds)
          .range(from, to)
      );
      for (const l of links) {
        status[l.product_id] = l.channel_status ?? "Not Listed";
        if (l.channel_price != null) priceOverride[l.product_id] = l.channel_price;
      }
    }

    let csv: string;
    if (channel === "talabat") {
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
      const variants = (await fetchAll((from, to) =>
        supabase.from("product_variants")
          .select("parent_product_id, variant_name, variant_name_en, sku, barcode, price, stock_quantity")
          .range(from, to)
      )) as any[];

      const productInputs: ExportProductInput[] = prods.map((p: any) => ({
        id: p.id, sku: p.sku, barcode: p.barcode,
        name_en: p.name_en, name_ar: p.name_ar,
        price: p.price, discount_price: p.discount_price,
        main_category: p.main_category,
        description_en: p.description_en, description_ar: p.description_ar,
        image_filename: p.image_filename, image_url: p.image_url,
        channel_price: priceOverride[p.id] ?? null,
        approved: status[p.id] !== "Not Listed", // undefined status ⇒ included
      }));
      const variantInputs: ExportVariantInput[] = variants.map((v) => ({
        parent_product_id: v.parent_product_id, sku: v.sku, barcode: v.barcode,
        variant_name: v.variant_name, variant_name_en: v.variant_name_en,
        price: v.price, stock_quantity: v.stock_quantity,
      }));

      const result = buildTalabatExport(productInputs, variantInputs);

      // Persist mappings for VALID rows only, via the service-role client.
      // Best-effort: a persistence failure never breaks the export download and
      // never surfaces a raw DB error.
      const talabatChannelId = chanIds[0];
      if (talabatChannelId && result.mappings.length) {
        try {
          const admin = createAdminClient() as unknown as MappingWriteClient;
          await persistTalabatMappings(admin, talabatChannelId, result.mappings, new Date().toISOString());
        } catch { /* export still returns the valid rows */ }
      }

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
    } else if (channel === "shopify") {
      csv = buildShopifyCsv(products, status);
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
    return new Response(`Export failed: ${e instanceof Error ? e.message : "error"}`, { status: 500 });
  }
}
