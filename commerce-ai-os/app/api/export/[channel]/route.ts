import { createClient } from "@/lib/supabase/server";
import {
  buildShopifyCsv, buildSnoonuCsv, buildTalabatCsv, buildRafeeqCsv,
  CHANNEL_KEYS, type ChannelKey, type ExportProduct,
  type ExportVariant, type StatusMap,
} from "@/lib/exporters";

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
  _req: Request,
  { params }: { params: { channel: string } }
) {
  const channel = params.channel as ChannelKey;
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
        .select("id, sku, snoonu_id, barcode, name_en, name_ar, main_category, sub_category, product_type, price, discount_price, image_url, description_en, description_ar, keywords_en, keywords_ar")
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
    if (chanIds.length) {
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
      const variants = (await fetchAll((from, to) =>
        supabase.from("product_variants")
          .select("parent_product_id, variant_name, sku, price")
          .range(from, to)
      )) as ExportVariant[];
      csv = buildTalabatCsv(products, variants, status);
    } else if (channel === "shopify") {
      csv = buildShopifyCsv(products, status);
    } else if (channel === "snoonu") {
      csv = buildSnoonuCsv(products, status);
    } else {
      csv = buildRafeeqCsv(products, status);
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
