// Dev test: run the real CSV builders against the live DB and print samples.
// node scripts/test_exports.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import {
  buildShopifyCsv, buildSnoonuCsv, buildRafeeqCsv, CHANNEL_NAME,
} from "../lib/exporters.ts";
import { buildTalabatRows, rowsToCsv } from "../lib/malak/talabat-export.mjs";

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const PAGE = 1000;
async function all(table, cols) {
  const out = [];
  for (let f = 0; ; f += PAGE) {
    const { data, error } = await sb.from(table).select(cols).range(f, f + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...data); if (data.length < PAGE) break;
  }
  return out;
}
async function statusFor(channelKey) {
  const { data: chans } = await sb.from("channels").select("id").ilike("name", "%"+channelKey+"%");
  const ids = (chans ?? []).map((c) => c.id);
  const map = {};
  if (ids.length) {
    for (let f = 0; ; f += PAGE) {
      const { data } = await sb.from("channel_products").select("product_id, channel_status").in("channel_id", ids).range(f, f + PAGE - 1);
      data.forEach((l) => (map[l.product_id] = l.channel_status ?? "Not Listed"));
      if (data.length < PAGE) break;
    }
  }
  return map;
}

const products = await all("products", "id, sku, snoonu_id, barcode, name_en, name_ar, main_category, sub_category, product_type, price, discount_price, image_url, description_en, description_ar, keywords_en, keywords_ar");
const variants = await all("product_variants", "parent_product_id, variant_name, sku, price");

const outputs = {
  shopify: buildShopifyCsv(products, await statusFor("shopify")),
  snoonu: buildSnoonuCsv(products, await statusFor("snoonu")),
  talabat: rowsToCsv(buildTalabatRows(products, variants).rows),
  rafeeq: buildRafeeqCsv(products, await statusFor("rafeeq")),
};

console.log(`products=${products.length}  variants=${variants.length}\n`);
for (const [k, csv] of Object.entries(outputs)) {
  const lines = csv.split("\r\n");
  writeFileSync(`/tmp/${k}_export.csv`, "﻿" + csv);
  console.log(`===== ${k.toUpperCase()}  (${lines.length - 1} data rows) =====`);
  console.log("HEADER : " + lines[0]);
  console.log("ROW 1  : " + lines[1]);
  console.log("ROW 2  : " + lines[2]);
  console.log("");
}
process.exit(0);
