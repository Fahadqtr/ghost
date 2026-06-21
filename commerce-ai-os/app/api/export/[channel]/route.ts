import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createClient } from "@/lib/supabase/server";
import {
  buildShopifyCsv, buildSnoonuCsv, buildRafeeqAoa, RAFEEQ_COL_WIDTHS,
  CHANNEL_KEYS, type ChannelKey, type ExportProduct,
  type ExportVariant, type StatusMap,
} from "@/lib/exporters";
import {
  buildTalabatRows, rowsToCsv, masterDescEnFromRows,
} from "@/lib/malak/talabat-export.mjs";

export const runtime = "nodejs"; // needs fs to read the master sheet fallback
export const dynamic = "force-dynamic";

// Master sheet (gitignored, present locally / not on Vercel) → SKU→Description-EN
// map. Used ONLY to fill an empty DB description; absent file → empty map.
function loadMasterDescEn(): Map<string, string> {
  try {
    const require = createRequire(import.meta.url);
    const XLSX = require("xlsx");
    const buf = readFileSync("./Malikas_Universe_CLEAN_28col.xlsx");
    const wb = XLSX.read(buf, { type: "buffer" });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" });
    return masterDescEnFromRows(rows);
  } catch {
    return new Map(); // not deployed → DB stays the only source
  }
}

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
      // Same format as scripts/export_talabat.mjs (shared module): 10 columns,
      // one row per variant ({sku}-{seq}), Description EN gap-filled from master.
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
          .select("parent_product_id, variant_name, sku, price")
          .range(from, to)
      )) as ExportVariant[];
      const { rows } = buildTalabatRows(prods, variants, loadMasterDescEn());
      csv = rowsToCsv(rows);
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
