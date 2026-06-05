// REAL breakdown: DB products vs a real Snoonu-format export file, matched by
// SKU, using the actual computeChanges/normalizeText. node scripts/snoonu_real_breakdown.mjs
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createClient } from "@supabase/supabase-js";
import { computeChanges, ALWAYS } from "../lib/snoonu-diff.ts";

const require = createRequire(import.meta.url);
const XLSX = require("xlsx");
const env = Object.fromEntries(readFileSync(".env.local","utf8").split("\n").filter(l=>l.includes("=")&&!l.trim().startsWith("#")).map(l=>{const i=l.indexOf("=");return[l.slice(0,i).trim(),l.slice(i+1).trim()];}));
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const FILE = "/tmp/imgjob/extracted/New folder (13)/Malikas_Universe.xlsx";
// Final-sheet header -> our export field
const MAP = {
  "Product Name EN": "name_en", "Product Name AR": "name_ar",
  "Description EN": "description_en", "Description AR": "description_ar",
  "Price (QAR)": "price", "Discount": "discount",
};

const fileRows = XLSX.utils.sheet_to_json(XLSX.readFile(FILE).Sheets["Final"], { defval: "" });
console.log(`Real Snoonu-format file: ${fileRows.length} rows (sheet "Final")`);
console.log("NOTE: this is the only real Snoonu-format file in the container — NOT your");
console.log("actual NonFoodProducts export. Mechanics are real; exact numbers will differ.\n");

// DB products by sku
const prods = [];
for (let f = 0; ; f += 1000) { const { data } = await sb.from("products").select("sku, name_en, name_ar, description_en, description_ar, price, discount_price").range(f, f+999); prods.push(...data); if (data.length<1000) break; }
const bySku = new Map(prods.map(p => [String(p.sku).toLowerCase(), p]));

let matched = 0, changedProducts = 0;
const byField = {};
const sampleDescDiffs = [];
for (const r of fileRows) {
  const sku = String(r.SKU ?? "").trim().toLowerCase();
  const p = bySku.get(sku);
  if (!p) continue;
  matched++;
  const exRow = {};
  for (const [h, f] of Object.entries(MAP)) exRow[f] = String(r[h] ?? "").trim();
  const ch = computeChanges(p, exRow, ALWAYS);
  if (ch.length) changedProducts++;
  for (const c of ch) {
    byField[c.field] = (byField[c.field] || 0) + 1;
    if (c.field === "description_en" && sampleDescDiffs.length < 3) sampleDescDiffs.push({ sku, oldLen: c.old.length, newLen: c.new.length });
  }
}

console.log(`matched by SKU: ${matched} | products with >=1 real change: ${changedProducts}`);
console.log("CHANGES BY FIELD (after improved normalization):");
for (const f of ALWAYS) console.log(`  ${f.col.padEnd(16)} ${byField[f.col] || 0}`);
console.log("\nsample remaining description_en diffs (old vs new length):", JSON.stringify(sampleDescDiffs));
process.exit(0);
