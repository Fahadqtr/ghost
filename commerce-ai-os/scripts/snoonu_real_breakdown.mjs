// REAL per-field breakdown of a Snoonu NonFoodProducts export vs our DB,
// matched by snoonu_id, using the actual diff code.
// node scripts/snoonu_real_breakdown.mjs <file.xlsx> [sheet]
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createClient } from "@supabase/supabase-js";
import { mapExportRows, diffSnoonu, computeChanges, ALWAYS, OPTIONAL, readColumns, normalizeText } from "../lib/snoonu-diff.ts";

const require = createRequire(import.meta.url);
const XLSX = require("xlsx");
const file = process.argv[2];
const sheet = process.argv[3] || "NonFoodProducts";
if (!file) { console.error("usage: node scripts/snoonu_real_breakdown.mjs <file.xlsx> [sheet]"); process.exit(1); }

const env = Object.fromEntries(readFileSync(".env.local","utf8").split("\n").filter(l=>l.includes("=")&&!l.trim().startsWith("#")).map(l=>{const i=l.indexOf("=");return[l.slice(0,i).trim(),l.slice(i+1).trim()];}));
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const wb = XLSX.readFile(file);
if (!wb.SheetNames.includes(sheet)) { console.error(`sheet "${sheet}" not found. sheets: ${wb.SheetNames}`); process.exit(1); }
const raw = XLSX.utils.sheet_to_json(wb.Sheets[sheet], { defval: "" });
const { rows, hasId } = mapExportRows(raw);
console.log(`file rows=${raw.length} parsed(with id)=${rows.length} hasId=${hasId}`);

// feature-detect optional columns
const fields = [...ALWAYS];
for (const f of OPTIONAL) { const { error } = await sb.from("products").select(f.col).limit(1); if (!error) fields.push(f); }
console.log("fields compared:", fields.map(f => f.col).join(", "));

// read all products
const products = [];
for (let from = 0; ; from += 1000) { const { data } = await sb.from("products").select(readColumns(fields)).range(from, from+999); products.push(...data); if (data.length<1000) break; }

const d = diffSnoonu(products, rows, fields);
const byField = {};
for (const u of d.updated) for (const ch of u.changes) byField[ch.field] = (byField[ch.field] || 0) + 1;

console.log("\n================ TRUE BREAKDOWN ================");
console.log(`Export rows:     ${rows.length}`);
console.log(`Matched:         ${d.matched}`);
console.log(`WILL UPDATE:     ${d.updated.length}   (products with >=1 real change)`);
console.log(`Unchanged:       ${d.unchanged}`);
console.log(`New (not in DB): ${d.newProducts.length}`);
console.log(`Missing:         ${d.missing.length}`);
console.log("\nCHANGES BY FIELD:");
for (const f of fields) console.log(`  ${f.col.padEnd(18)} ${byField[f.col] || 0}`);

// show a couple real description diffs (around first difference)
const descSamples = d.updated.filter(u => u.changes.some(c => c.field === "description_en")).slice(0, 3);
console.log("\nsample description_en diffs:");
for (const u of descSamples) {
  const c = u.changes.find(x => x.field === "description_en");
  let i = 0; const n = Math.min(c.old.length, c.new.length); while (i < n && c.old[i] === c.new[i]) i++;
  console.log(`  ${u.snoonu_id} len ${c.old.length}->${c.new.length} firstDiff@${i}`);
  console.log(`    DB  : ${JSON.stringify(c.old.slice(Math.max(0,i-15), i+25))}`);
  console.log(`    FILE: ${JSON.stringify(c.new.slice(Math.max(0,i-15), i+25))}`);
}
process.exit(0);
