// One-time: backfill products.snoonu_id from a [{sku, snoonu_id}] JSON.
// Usage: node scripts/fill_snoonu_id.mjs <mapping.json>
// Data only, no schema changes.
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const path = process.argv[2];
if (!path) { console.error("Usage: node scripts/fill_snoonu_id.mjs <mapping.json>"); process.exit(1); }

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
if (!env.SUPABASE_SERVICE_ROLE_KEY) { console.error("✗ SUPABASE_SERVICE_ROLE_KEY missing"); process.exit(1); }
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const pairs = JSON.parse(readFileSync(path, "utf8"));
console.log(`Loaded ${pairs.length} pairs from ${path}`);

let updated = 0, notFound = 0, errors = 0;
const missingSkus = [];
let done = 0;

async function applyOne(p) {
  const sku = String(p.sku ?? "").trim();
  const id = p.snoonu_id;
  if (!sku || id === undefined || id === null || id === "") { errors++; return; }
  const { data, error } = await sb.from("products").update({ snoonu_id: String(id) }).eq("sku", sku).select("id");
  if (error) { errors++; console.error("  err", sku, error.message); return; }
  if ((data ?? []).length === 0) { notFound++; missingSkus.push(sku); }
  else updated += data.length;
  if (++done % 200 === 0) process.stdout.write(`\r  processed ${done}/${pairs.length}`);
}

// concurrency pool
const CONC = 12;
let idx = 0;
async function worker() { while (idx < pairs.length) { await applyOne(pairs[idx++]); } }
await Promise.all(Array.from({ length: CONC }, worker));
process.stdout.write("\n");

// final count
const { count } = await sb.from("products").select("*", { count: "exact", head: true }).not("snoonu_id", "is", null);

console.log("\n================ REPORT ================");
console.log("Pairs in file:           ", pairs.length);
console.log("Rows updated:            ", updated);
console.log("SKUs not found in DB:    ", notFound);
if (missingSkus.length) console.log("  missing:", missingSkus.slice(0, 30).join(", ") + (missingSkus.length > 30 ? " …" : ""));
console.log("Pair errors (bad data):  ", errors);
console.log("\nFINAL count products WHERE snoonu_id IS NOT NULL:", count, count === 1146 ? "✓ (expected 1146)" : "");
process.exit(0);
