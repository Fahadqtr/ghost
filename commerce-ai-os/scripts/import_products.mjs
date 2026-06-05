// One-time bulk import: Malika's Universe clean 28-column product file.
//
// Usage:  node scripts/import_products.mjs
// Requires NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env.local.
// The service-role key bypasses RLS for this admin task — it is read from the
// gitignored .env.local and never printed.
//
// Idempotent / safe to re-run:
//   • products: existing SKUs are skipped (ON CONFLICT (sku) DO NOTHING equivalent,
//     implemented in app code so it needs no unique constraint / schema change)
//   • inventory: seeded only for products that don't already have a row
//   • product_variants: seeded only for products that currently have none
//
// Does NOT alter schema structure.

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import * as XLSX from "xlsx";

const FILE = "./Malikas_Universe_CLEAN_28col.xlsx";
const CHUNK = 500;

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
const S = (v) => { const t = String(v ?? "").trim(); return t === "" ? null : t; };
const N = (v) => { const t = String(v ?? "").trim(); if (t === "") return null; const n = Number(t); return isNaN(n) ? null : n; };
const chunks = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24);

async function die(label, error) {
  if (error) { console.error(`✗ ${label}:`, error.message ?? error); process.exit(1); }
}

// ---- load file ------------------------------------------------------------
const wb = XLSX.readFile(FILE);
const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" });
console.log(`Loaded ${rows.length} rows from ${FILE}`);

const categories = [...new Set(rows.map((r) => S(r["Main Category"])).filter(Boolean))];
console.log(`Distinct categories: ${categories.length}`);

// ---- 1) delete test rows --------------------------------------------------
console.log("\n[1] Deleting test rows (sku = '7673' or sku LIKE 'TEST-%') …");
{
  const { data: testRows, error } = await supabase
    .from("products").select("id").or("sku.eq.7673,sku.like.TEST-%");
  await die("select test rows", error);
  const ids = (testRows ?? []).map((r) => r.id);
  if (ids.length) {
    for (const tbl of ["product_variants"]) {
      await die(tbl, (await supabase.from(tbl).delete().in("parent_product_id", ids)).error);
    }
    for (const tbl of ["channel_products", "inventory", "product_images"]) {
      await die(tbl, (await supabase.from(tbl).delete().in("product_id", ids)).error);
    }
    await die("delete test products", (await supabase.from("products").delete().in("id", ids)).error);
  }
  console.log(`    removed ${ids.length} test product(s)`);
}

// ---- 2) replace product_categories with the real list ---------------------
console.log("\n[2] Replacing product_categories …");
{
  await die("clear categories", (await supabase.from("product_categories").delete().not("id", "is", null)).error);
  await die("insert categories", (await supabase.from("product_categories").insert(categories.map((name) => ({ name }))).select("id")).error);
  console.log(`    inserted ${categories.length} categories`);
}

// ---- 3) insert products (skip existing SKUs) ------------------------------
console.log("\n[3] Inserting products …");
const fileSkus = rows.map((r) => S(r.SKU)).filter(Boolean);

// existing skus -> skip
const existing = new Set();
for (const part of chunks(fileSkus, CHUNK)) {
  const { data, error } = await supabase.from("products").select("sku").in("sku", part);
  await die("select existing skus", error);
  (data ?? []).forEach((r) => existing.add(r.sku));
}

const toInsert = rows
  .filter((r) => S(r.SKU) && !existing.has(S(r.SKU)))
  .map((r) => ({
    sku: S(r.SKU),
    barcode: S(r.Barcode),
    name_en: S(r["Product Name EN"]),
    name_ar: S(r["Product Name AR"]),
    brand_id: null, // file has no brand data
    main_category: S(r["Main Category"]),
    sub_category: S(r["Sub Category"]),
    product_type: S(r["Product Type"]),
    color: S(r.Color),
    size: S(r.Size),
    price: N(r.Price),
    discount_price: N(r["Discount Price"]),
    cost: N(r.Cost),
    stock_quantity: N(r["Stock Quantity"]),
    stock_status: S(r["Stock Status"]),
    platform_status: S(r["Platform Status"]),
    image_filename: S(r["Image Filename"]),
    image_url: S(r["Image URL"]),
    description_en: S(r["Description EN"]),
    description_ar: S(r["Description AR"]),
    keywords_en: S(r["Keywords EN"]),
    keywords_ar: S(r["Keywords AR"]),
    notes: S(r.Notes),
  }));

console.log(`    ${existing.size} already present (skipped), ${toInsert.length} to insert`);
for (const part of chunks(toInsert, CHUNK)) {
  await die("insert products", (await supabase.from("products").insert(part)).error);
}

// resolve sku -> id for ALL file products (new + pre-existing)
const skuToId = new Map();
for (const part of chunks(fileSkus, CHUNK)) {
  const { data, error } = await supabase.from("products").select("id, sku").in("sku", part);
  await die("map skus", error);
  (data ?? []).forEach((r) => skuToId.set(r.sku, r.id));
}

// ---- 4) seed inventory (only where missing) -------------------------------
console.log("\n[4] Seeding inventory …");
const allIds = [...skuToId.values()];
const haveInv = new Set();
for (const part of chunks(allIds, CHUNK)) {
  const { data, error } = await supabase.from("inventory").select("product_id").in("product_id", part);
  await die("select inventory", error);
  (data ?? []).forEach((r) => haveInv.add(r.product_id));
}
const invRows = rows
  .map((r) => ({ sku: S(r.SKU), stock: N(r["Stock Quantity"]) }))
  .filter((x) => x.sku && skuToId.has(x.sku) && !haveInv.has(skuToId.get(x.sku)))
  .map((x) => ({ product_id: skuToId.get(x.sku), stock_quantity: x.stock ?? 0, low_stock_threshold: 5, sold_quantity: 0 }));
for (const part of chunks(invRows, CHUNK)) {
  await die("insert inventory", (await supabase.from("inventory").insert(part)).error);
}
console.log(`    inserted ${invRows.length} inventory row(s)`);

// ---- 5) split Variant -> product_variants (only where product has none) ---
console.log("\n[5] Splitting variants …");
const haveVar = new Set();
for (const part of chunks(allIds, CHUNK)) {
  const { data, error } = await supabase.from("product_variants").select("parent_product_id").in("parent_product_id", part);
  await die("select variants", error);
  (data ?? []).forEach((r) => haveVar.add(r.parent_product_id));
}
const variantRows = [];
for (const r of rows) {
  const sku = S(r.SKU);
  const raw = S(r.Variant);
  if (!sku || !raw || !skuToId.has(sku)) continue;
  const pid = skuToId.get(sku);
  if (haveVar.has(pid)) continue;
  const opts = raw.split("|").map((o) => o.trim()).filter(Boolean);
  opts.forEach((opt, i) => {
    variantRows.push({
      parent_product_id: pid,
      variant_name: opt,
      sku: `${sku}-${slug(opt) || "v" + (i + 1)}`,
      color: null, size: null,
      price: N(r.Price),
      stock_quantity: null,
    });
  });
}
for (const part of chunks(variantRows, CHUNK)) {
  await die("insert variants", (await supabase.from("product_variants").insert(part)).error);
}
console.log(`    inserted ${variantRows.length} variant row(s) from ${new Set(variantRows.map(v=>v.parent_product_id)).size} product(s)`);

// ---- 6) verify ------------------------------------------------------------
console.log("\n[6] Final counts:");
for (const tbl of ["products", "product_categories", "inventory", "product_variants"]) {
  const { count, error } = await supabase.from(tbl).select("*", { count: "exact", head: true });
  await die(`count ${tbl}`, error);
  console.log(`    ${tbl.padEnd(20)} ${count}`);
}
console.log("\n✓ Import complete.");
