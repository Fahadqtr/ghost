// Local reproduction of the Snoonu Sync diff. node scripts/test_snoonu_diff.mjs
// Fabricates a 61-col NonFoodProducts sheet, parses it with the SAME shared
// code the page uses, and runs the SAME diff. Tests anon + service-role reads.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createClient } from "@supabase/supabase-js";
import { mapExportRows, diffSnoonu, ALWAYS, OPTIONAL, readColumns } from "../lib/snoonu-diff.ts";

const require = createRequire(import.meta.url);
const XLSX = require("xlsx");

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8").split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const URL = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;

async function detectFields(client) {
  const fields = [...ALWAYS];
  for (const f of OPTIONAL) { const { error } = await client.from("products").select(f.col).limit(1); if (!error) fields.push(f); }
  return fields;
}
async function readAll(client, cols) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await client.from("products").select(cols).range(from, from + 999);
    if (error) throw new Error(`read products: ${error.message}`);
    out.push(...(data ?? [])); if ((data ?? []).length < 1000) break;
  }
  return out;
}

// --- fabricate a 61-column, 3-row export ----------------------------------
const NAMED = ["id","global_id","name_en","name_ar","description_en","description_ar","price","discount","approval","is_featured","is_promoted","has_buy1get1","sku","barcode"];
const headers = [...NAMED]; while (headers.length < 61) headers.push(`extra_${headers.length}`);

// grab 2 real snoonu_ids (service role) so we get real matches
const svc = createClient(URL, SERVICE, { auth: { persistSession: false } });
const { data: sample } = await svc.from("products").select("snoonu_id, name_en, price").not("snoonu_id", "is", null).limit(2);
const real = sample ?? [];

function mkRow(over) { const o = {}; for (const h of headers) o[h] = ""; return Object.assign(o, over); }
const fab = [
  mkRow({ id: real[0]?.snoonu_id ?? "MISSINGID0", name_en: (real[0]?.name_en ?? "X") + " CHANGED", price: Number(real[0]?.price ?? 0) + 7, approval: "Approved", is_featured: "TRUE" }),
  mkRow({ id: real[1]?.snoonu_id ?? "MISSINGID1", name_en: real[1]?.name_en ?? "Y", price: real[1]?.price ?? 1 }), // unchanged-ish
  mkRow({ id: "ffffffffffffffffffffffff", name_en: "Totally New Product", price: 99 }), // NEW
];
const ws = XLSX.utils.json_to_sheet(fab, { header: headers });
const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "NonFoodProducts");
XLSX.writeFile(wb, "/tmp/fake_snoonu.xlsx");
console.log(`Fabricated /tmp/fake_snoonu.xlsx — ${headers.length} columns, ${fab.length} rows`);

// parse it back exactly like the page
const raw = XLSX.utils.sheet_to_json(XLSX.readFile("/tmp/fake_snoonu.xlsx").Sheets["NonFoodProducts"], { defval: "" });
const { rows, hasId, headers: parsedHeaders } = mapExportRows(raw);
console.log(`Parsed rows=${rows.length} hasId=${hasId} (mapped from ${parsedHeaders.length} headers)`);
console.log("sample parsed row:", JSON.stringify(rows[0]));

async function runWith(label, key) {
  console.log(`\n===== DIFF via ${label} =====`);
  try {
    const client = createClient(URL, key, { auth: { persistSession: false } });
    const fields = await detectFields(client);
    console.log("  fields compared:", fields.map((f) => f.col).join(", "));
    console.log("  read columns:", readColumns(fields));
    const products = await readAll(client, readColumns(fields));
    console.log("  products read:", products.length);
    const d = diffSnoonu(products, rows, fields);
    console.log(`  RESULT -> matched=${d.matched} updated=${d.updated.length} new=${d.newProducts.length} missing=${d.missing.length} unchanged=${d.unchanged}`);
    if (d.updated[0]) console.log("  sample change:", JSON.stringify(d.updated[0].changes));
  } catch (e) {
    console.error(`  ✗ ERROR (${label}):`, e?.message);
    console.error(e?.stack);
  }
}

await runWith("ANON key (reproduces production read)", ANON);
await runWith("SERVICE role (full data)", SERVICE);
process.exit(0);
