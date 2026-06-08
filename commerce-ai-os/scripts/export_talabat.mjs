// Talabat final catalog export → talabat_catalog_final.csv (project root).
//
// READ-ONLY: reads products + product_variants from Supabase and writes a CSV.
// It NEVER writes to the database.
//
// Usage:  node scripts/export_talabat.mjs
// Requires NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env.local
// (service-role bypasses RLS for this admin read; key is read from the
// gitignored .env.local and never printed).
//
// Row logic:
//   • Products with NO variants  → one row, as-is.
//   • Products WITH variants     → one row per variant:
//       - SKU            = {parentSku}-{seq}        (e.g. mk870-1, mk870-2)
//       - Product Name EN = name_en + " - " + variant_name
//       - Product Name AR = name_ar + " - " + variant_name
//       - Barcode/Price/Discount/Descriptions = inherited from the parent
//       - New Image Filename = "" (filled in later)
//   • Ambiguous variant labels (e.g. "#03") are kept verbatim in the name.

import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const OUT = "./talabat_catalog_final.csv";

// Exact column order requested.
const HEADERS = [
  "SKU",
  "Barcode",
  "Price (QAR)",
  "Discount",
  "Product Name EN",
  "Product Name AR",
  "Description EN",
  "Description AR",
  "New Image Filename",
];

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

// ---- helpers --------------------------------------------------------------
const chunks = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
const S = (v) => (v == null ? "" : String(v).trim());
// RFC-4180 CSV cell: quote when it contains comma/quote/newline; escape quotes.
const cell = (v) => {
  const s = S(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// Pull every row of a table via keyset-free pagination (Supabase caps at 1000).
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

const productById = new Map(products.map((p) => [p.id, p]));

// Group variants by parent, ordered by the numeric index baked into their sku
// ({parentSku}-{N}-{slug}). That index becomes the export seq, so the order
// matches the original pipe-delimited Variant column (mk870-1=Blue, -2=Pink…).
const variantsByParent = new Map();
for (const v of variants) {
  const arr = variantsByParent.get(v.parent_product_id) ?? [];
  arr.push(v);
  variantsByParent.set(v.parent_product_id, arr);
}
function seqOf(parentSku, variantSku) {
  // strip "{parentSku}-" then read the leading integer; fallback handled by caller
  const rest = S(variantSku).startsWith(parentSku + "-") ? S(variantSku).slice(parentSku.length + 1) : "";
  const n = parseInt(rest, 10);
  return Number.isFinite(n) ? n : null;
}

// ---- build rows -----------------------------------------------------------
const rows = [];
let withVariants = 0;
let withoutVariants = 0;

for (const p of products) {
  const vs = variantsByParent.get(p.id);
  if (!vs || vs.length === 0) {
    // Plain product — one row as-is.
    withoutVariants++;
    rows.push({
      SKU: S(p.sku),
      Barcode: S(p.barcode),
      "Price (QAR)": S(p.price),
      Discount: S(p.discount_price),
      "Product Name EN": S(p.name_en),
      "Product Name AR": S(p.name_ar),
      "Description EN": S(p.description_en),
      "Description AR": S(p.description_ar),
      "New Image Filename": "",
    });
    continue;
  }
  // Product with variants — one row each, ordered by the embedded index.
  withVariants++;
  const ordered = vs
    .map((v, i) => ({ v, seq: seqOf(p.sku, v.sku) ?? i + 1 }))
    .sort((a, b) => a.seq - b.seq);
  for (const { v, seq } of ordered) {
    const name = S(v.variant_name);
    rows.push({
      SKU: `${S(p.sku)}-${seq}`,
      Barcode: S(p.barcode),
      "Price (QAR)": S(p.price),
      Discount: S(p.discount_price),
      "Product Name EN": name ? `${S(p.name_en)} - ${name}` : S(p.name_en),
      "Product Name AR": name ? `${S(p.name_ar)} - ${name}` : S(p.name_ar),
      "Description EN": S(p.description_en),
      "Description AR": S(p.description_ar),
      "New Image Filename": "",
    });
  }
}

// ---- write CSV ------------------------------------------------------------
const lines = [HEADERS.join(",")];
for (const r of rows) lines.push(HEADERS.map((h) => cell(r[h])).join(","));
// Prepend UTF-8 BOM so Excel renders the Arabic columns correctly.
writeFileSync(OUT, "﻿" + lines.join("\r\n") + "\r\n", "utf8");

// ---- completeness report --------------------------------------------------
// "Missing" = empty cell. New Image Filename is intentionally empty (excluded).
const checkCols = HEADERS.filter((h) => h !== "New Image Filename");
const missing = {};
for (const h of checkCols) missing[h] = 0;
for (const r of rows) for (const h of checkCols) if (S(r[h]) === "") missing[h]++;

console.log("\n========== EXPORT SUMMARY ==========");
console.log(`Products total ............ ${products.length}`);
console.log(`  • without variants ...... ${withoutVariants} (one row each)`);
console.log(`  • with variants ......... ${withVariants} → ${variants.length} variant rows`);
console.log(`TOTAL ROWS WRITTEN ........ ${rows.length}`);
console.log(`File ...................... ${OUT}`);
console.log("\nMissing (empty) cells per column [New Image Filename excluded by design]:");
let anyMissing = false;
for (const h of checkCols) {
  if (missing[h] > 0) { anyMissing = true; console.log(`  ⚠ ${h.padEnd(18)} ${missing[h]} empty`); }
}
if (!anyMissing) console.log("  ✓ ZERO missing fields across all columns (except New Image Filename).");
console.log("====================================");
