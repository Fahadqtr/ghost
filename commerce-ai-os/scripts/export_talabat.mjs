// Talabat final catalog export → talabat_catalog_final.csv (project root).
//
// READ-ONLY: reads products + product_variants from Supabase and writes a CSV.
// It NEVER writes to the database. The row/column FORMAT lives in the shared
// module lib/malak/talabat-export.mjs — the SAME module the in-app export
// button uses — so the CLI and the button can never drift.
//
// Usage:  node scripts/export_talabat.mjs
// Requires NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env.local
// (service-role bypasses RLS for this admin read; key is read from the
// gitignored .env.local and never printed).

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createClient } from "@supabase/supabase-js";
import {
  TALABAT_HEADERS,
  buildTalabatRows,
  rowsToCsv,
  masterDescEnFromRows,
} from "../lib/malak/talabat-export.mjs";

const require = createRequire(import.meta.url);
const XLSX = require("xlsx"); // CJS — load via require for reliable interop

const OUT = "./talabat_catalog_final.csv";
const MASTER = "./Malikas_Universe_CLEAN_28col.xlsx"; // fallback for empty fields

// ---- env ------------------------------------------------------------------
function loadEnv() {
  const txt = readFileSync(".env.local", "utf8");
  const env = {};
  for (const line of txt.split("\n")) {
    const i = line.indexOf("=");
    if (i === -1 || line.trim().startsWith("#")) continue;
    env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return env;
}
const env = loadEnv();
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("✗ Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}
const supabase = createClient(url, key, { auth: { persistSession: false } });

// Pull every row of a table via pagination (Supabase caps at 1000).
async function fetchAll(table, columns) {
  const all = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from(table).select(columns).range(from, from + PAGE - 1);
    if (error) { console.error(`✗ read ${table}:`, error.message); process.exit(1); }
    all.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return all;
}

// ---- load -----------------------------------------------------------------
const products = await fetchAll(
  "products",
  "id, sku, barcode, price, discount_price, name_en, name_ar, description_en, description_ar"
);
const variants = await fetchAll("product_variants", "parent_product_id, variant_name, sku");
console.log(`Loaded ${products.length} products, ${variants.length} variants.`);

// Master sheet → SKU → Description EN (fills only DB gaps; never written back).
let masterDescEn = new Map();
try {
  const wb = XLSX.readFile(MASTER);
  const mrows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" });
  masterDescEn = masterDescEnFromRows(mrows);
  console.log(`Loaded master sheet: ${masterDescEn.size} SKUs with Description EN.`);
} catch (e) {
  console.warn(`⚠ Could not read master sheet (${MASTER}): ${e.message} — proceeding without fallback.`);
}

// ---- build + write (shared format) ----------------------------------------
const { rows, stats } = buildTalabatRows(products, variants, masterDescEn);
// Prepend UTF-8 BOM so Excel renders the Arabic columns correctly.
writeFileSync(OUT, "﻿" + rowsToCsv(rows), "utf8");

// ---- completeness report --------------------------------------------------
const checkCols = TALABAT_HEADERS.filter((h) => h !== "New Image Filename");
const missing = Object.fromEntries(checkCols.map((h) => [h, 0]));
for (const r of rows) for (const h of checkCols) if (String(r[h] ?? "").trim() === "") missing[h]++;

console.log("\n========== EXPORT SUMMARY ==========");
console.log(`Products total ............ ${stats.productsTotal}`);
console.log(`  • without variants ...... ${stats.withoutVariants} (one row each)`);
console.log(`  • with variants ......... ${stats.withVariants} → ${stats.variantRows} variant rows`);
console.log(`TOTAL ROWS WRITTEN ........ ${rows.length}`);
console.log(`File ...................... ${OUT}`);
console.log(`\nDescription EN filled from master sheet: ${stats.descEnFromMaster} product(s).`);
console.log(`Products STILL missing Description EN (DB + master): ${stats.stillEmpty.length}`);
if (stats.stillEmpty.length) {
  console.log("  SKU | Product Name EN");
  for (const p of stats.stillEmpty) console.log(`  ${p.sku} | ${p.name_en}`);
}
console.log("\nMissing (empty) cells per column [New Image Filename excluded by design]:");
let anyMissing = false;
for (const h of checkCols) {
  if (missing[h] > 0) { anyMissing = true; console.log(`  ⚠ ${h.padEnd(18)} ${missing[h]} empty`); }
}
if (!anyMissing) console.log("  ✓ ZERO missing fields across all columns (except New Image Filename).");
console.log("====================================");
