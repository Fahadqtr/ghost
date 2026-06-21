// Download every product image from Supabase Storage (bucket product-images)
// into exports/talabat-images/, each saved under its image_filename so the
// folder matches the "New Image Filename" column in the Talabat export exactly.
//
// READ-ONLY on the database: it only reads products + downloads public files.
// It never writes to the DB. Source of each image = the product's image_url
// (which points at product-images/<file>); saved name = image_filename.
//
// Usage:  node scripts/download_images.mjs
// Requires NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env.local.

import { readFileSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const OUT_DIR = "exports/talabat-images";
const CONCURRENCY = 8;

const env = {};
readFileSync(".env.local", "utf8").split("\n").forEach((l) => {
  const i = l.indexOf("="); if (i > 0 && !l.trim().startsWith("#")) env[l.slice(0, i).trim()] = l.slice(i + 1).trim();
});
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const S = (v) => (v == null ? "" : String(v).trim());

// ---- load products --------------------------------------------------------
const all = [];
for (let f = 0; ; f += 1000) {
  const { data, error } = await supabase.from("products").select("sku, image_filename, image_url").range(f, f + 999);
  if (error) { console.error("✗ read products:", error.message); process.exit(1); }
  all.push(...data); if (data.length < 1000) break;
}
console.log(`Loaded ${all.length} products.`);

const withFilename = all.filter((p) => S(p.image_filename) !== "");
const noFilename = all.filter((p) => S(p.image_filename) === "");

// Group by target file name (the Excel name). Dedupe so we download once.
const byFile = new Map(); // filename -> { urls:Set, skus:[] }
for (const p of withFilename) {
  const fn = S(p.image_filename);
  const e = byFile.get(fn) ?? { urls: new Set(), skus: [] };
  if (S(p.image_url)) e.urls.add(S(p.image_url));
  e.skus.push(S(p.sku));
  byFile.set(fn, e);
}

mkdirSync(OUT_DIR, { recursive: true });

// ---- download with a small concurrency pool -------------------------------
const targets = [...byFile.entries()];
const missing = [];   // filename in Excel with no retrievable file
const conflicts = []; // same filename referenced by >1 different url
let downloaded = 0, totalBytes = 0;

async function handle([fn, info]) {
  const urls = [...info.urls];
  if (urls.length === 0) { missing.push({ fn, reason: "no image_url", skus: info.skus }); return; }
  if (urls.length > 1) conflicts.push({ fn, urls, skus: info.skus });
  const url = urls[0];
  try {
    const r = await fetch(url);
    if (!r.ok) { missing.push({ fn, reason: `HTTP ${r.status}`, skus: info.skus }); return; }
    const buf = Buffer.from(await r.arrayBuffer());
    writeFileSync(`${OUT_DIR}/${fn}`, buf);
    downloaded++; totalBytes += buf.length;
  } catch (e) {
    missing.push({ fn, reason: e.message, skus: info.skus });
  }
}

// Run the pool.
let idx = 0;
async function worker() { while (idx < targets.length) { const i = idx++; await handle(targets[i]); if (downloaded && downloaded % 100 === 0) process.stdout.write(`  …${downloaded}\r`); } }
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

// ---- folder size ----------------------------------------------------------
const fmt = (b) => b > 1e9 ? (b / 1e9).toFixed(2) + " GB" : (b / 1e6).toFixed(1) + " MB";

console.log("\n========== IMAGE DOWNLOAD SUMMARY ==========");
console.log(`Output folder ............. ${OUT_DIR}/`);
console.log(`Unique image names ........ ${byFile.size}`);
console.log(`Downloaded ................ ${downloaded}`);
console.log(`Total size ................ ${fmt(totalBytes)}`);
console.log(`Products w/o image_filename (not in Excel): ${noFilename.length}` + (noFilename.length ? ` → ${noFilename.map((p) => S(p.sku)).join(", ")}` : ""));
console.log(`\nMissing match — Excel name with NO actual file in Storage: ${missing.length}`);
for (const m of missing) console.log(`  ${m.fn} (${m.reason}) — sku: ${m.skus.join(", ")}`);
if (conflicts.length) {
  console.log(`\n⚠ Same image_filename used by different URLs (saved the first): ${conflicts.length}`);
  for (const c of conflicts) console.log(`  ${c.fn} — skus: ${c.skus.join(", ")}`);
}
console.log("============================================");
