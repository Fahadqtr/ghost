// Fill missing English product descriptions in Supabase.
//
// Writes ONLY the `description_en` column, ONLY for products whose description
// is currently empty, ONLY for SKUs listed in scripts/en_descriptions.json.
// It touches no other field. Idempotent: re-running skips already-filled rows.
//
// Usage:
//   node scripts/fill_en_descriptions.mjs            # dry-run (prints plan)
//   node scripts/fill_en_descriptions.mjs --apply    # writes to Supabase
//
// Requires NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env.local.

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
const DATA = "./scripts/en_descriptions.json";

const env = {};
readFileSync(".env.local", "utf8").split("\n").forEach((l) => {
  const i = l.indexOf("="); if (i > 0 && !l.trim().startsWith("#")) env[l.slice(0, i).trim()] = l.slice(i + 1).trim();
});
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const S = (v) => (v == null ? "" : String(v).trim());

// Load the authored descriptions.
const entries = JSON.parse(readFileSync(DATA, "utf8"));
const bySku = new Map(entries.map((e) => [S(e.sku), S(e.en)]));
console.log(`Loaded ${bySku.size} authored descriptions from ${DATA}`);

// Pull all products (id, sku, current description_en) to know which are empty.
const all = [];
for (let f = 0; ; f += 1000) {
  const { data, error } = await supabase.from("products").select("id, sku, description_en").range(f, f + 999);
  if (error) { console.error("✗ read products:", error.message); process.exit(1); }
  all.push(...data); if (data.length < 1000) break;
}
const emptyBySku = new Map(all.filter((p) => S(p.description_en) === "").map((p) => [S(p.sku), p]));
console.log(`Products currently missing description_en: ${emptyBySku.size}`);

// Plan: only SKUs that are BOTH authored AND currently empty.
const toWrite = [];
const authoredButNotEmpty = [];
const emptyButNoText = [];
for (const [sku, p] of emptyBySku) {
  const text = bySku.get(sku);
  if (text) toWrite.push({ id: p.id, sku, text });
  else emptyButNoText.push(sku);
}
for (const sku of bySku.keys()) if (!emptyBySku.has(sku)) authoredButNotEmpty.push(sku);

console.log(`\nPlan: write ${toWrite.length} description(s).`);
if (authoredButNotEmpty.length) console.log(`  • ${authoredButNotEmpty.length} authored SKU(s) already have a description → skipped.`);
if (emptyButNoText.length) console.log(`  ⚠ ${emptyButNoText.length} empty SKU(s) have NO authored text: ${emptyButNoText.join(", ")}`);

if (!APPLY) {
  console.log("\n(dry-run) Re-run with --apply to write. First 3 planned:");
  for (const r of toWrite.slice(0, 3)) console.log(`  ${r.sku}: ${r.text.slice(0, 70)}…`);
  process.exit(0);
}

// Apply — update description_en ONLY, one row at a time, guarded by id.
let ok = 0, fail = 0;
for (const r of toWrite) {
  const { error } = await supabase.from("products").update({ description_en: r.text }).eq("id", r.id);
  if (error) { fail++; console.error(`✗ ${r.sku}:`, error.message); }
  else { ok++; if (ok % 20 === 0) console.log(`  …${ok}/${toWrite.length}`); }
}
console.log(`\nWrote ${ok} description(s)${fail ? `, ${fail} failed` : ""}.`);

// Verify remaining gaps.
const { count } = await supabase.from("products")
  .select("*", { count: "exact", head: true })
  .or("description_en.is.null,description_en.eq.");
console.log(`Products STILL missing description_en: ${count}`);
