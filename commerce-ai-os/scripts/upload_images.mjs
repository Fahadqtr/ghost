// One-time: upload product images to Supabase Storage and link them.
// Usage: node scripts/upload_images.mjs <images_dir>
// Reads SUPABASE_SERVICE_ROLE_KEY + URL from .env.local (cwd). No schema changes.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { createClient } from "@supabase/supabase-js";

const BUCKET = "product-images";
const CONCURRENCY = 8;
const IMG_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
const CONTENT_TYPE = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif" };

const dir = process.argv[2];
if (!dir) { console.error("Usage: node scripts/upload_images.mjs <images_dir>"); process.exit(1); }

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
if (!env.SUPABASE_SERVICE_ROLE_KEY) { console.error("✗ SUPABASE_SERVICE_ROLE_KEY missing"); process.exit(1); }
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// recursively collect image files
function walk(d, out = []) {
  for (const name of readdirSync(d)) {
    const p = join(d, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (IMG_EXT.has(extname(name).toLowerCase())) out.push(p);
  }
  return out;
}
const files = walk(dir);
// de-dup by basename (keep first)
const byBase = new Map();
for (const f of files) { const b = basename(f); if (!byBase.has(b.toLowerCase())) byBase.set(b.toLowerCase(), f); }
console.log(`Found ${files.length} image files (${byBase.size} unique basenames)`);

// ensure bucket (public)
{
  const { data: buckets } = await sb.storage.listBuckets();
  if (!(buckets ?? []).some((b) => b.name === BUCKET)) {
    const { error } = await sb.storage.createBucket(BUCKET, { public: true });
    if (error && !/already exists/i.test(error.message)) { console.error("✗ createBucket:", error.message); process.exit(1); }
    console.log(`Created public bucket "${BUCKET}"`);
  } else {
    await sb.storage.updateBucket(BUCKET, { public: true });
    console.log(`Bucket "${BUCKET}" exists (ensured public)`);
  }
}

// load products: lowercased image_filename -> product id
const prods = [];
for (let f = 0; ; f += 1000) {
  const { data, error } = await sb.from("products").select("id, image_filename, image_url").range(f, f + 999);
  if (error) { console.error("✗ read products:", error.message); process.exit(1); }
  prods.push(...data); if (data.length < 1000) break;
}
const fnameToId = new Map();
for (const p of prods) if (p.image_filename) fnameToId.set(String(p.image_filename).toLowerCase(), p.id);

// existing product_images urls to avoid duplicate inserts on re-run
const existingPi = new Set();
{
  for (let f = 0; ; f += 1000) {
    const { data, error } = await sb.from("product_images").select("product_id, url").range(f, f + 999);
    if (error) break;
    data.forEach((r) => existingPi.add(`${r.product_id}|${r.url}`));
    if (data.length < 1000) break;
  }
}

let uploaded = 0, upFail = 0, matched = 0;
const unmatched = [];
const piToInsert = [];
const matchedProductIds = new Set();

async function processFile(path) {
  const base = basename(path);
  const ext = extname(base).toLowerCase();
  const buf = readFileSync(path);
  const { error: upErr } = await sb.storage.from(BUCKET).upload(base, buf, {
    contentType: CONTENT_TYPE[ext] ?? "application/octet-stream", upsert: true,
  });
  if (upErr) { upFail++; console.error("  upload fail", base, upErr.message); return; }
  uploaded++;
  const url = sb.storage.from(BUCKET).getPublicUrl(base).data.publicUrl;

  const pid = fnameToId.get(base.toLowerCase());
  if (!pid) { unmatched.push(base); return; }
  matched++; matchedProductIds.add(pid);
  const { error: updErr } = await sb.from("products").update({ image_url: url }).eq("id", pid);
  if (updErr) console.error("  update image_url fail", base, updErr.message);
  if (!existingPi.has(`${pid}|${url}`)) piToInsert.push({ product_id: pid, url, is_primary: true });
}

// simple concurrency pool
const items = [...byBase.values()];
let idx = 0;
async function worker() { while (idx < items.length) { const i = idx++; await processFile(items[i]); if (uploaded % 100 === 0 && uploaded) process.stdout.write(`\r  uploaded ${uploaded}/${items.length}`); } }
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
process.stdout.write("\n");

// batch insert product_images
for (let i = 0; i < piToInsert.length; i += 500) {
  const { error } = await sb.from("product_images").insert(piToInsert.slice(i, i + 500));
  if (error) console.error("  product_images insert fail:", error.message);
}

// products still missing image_url (re-read)
const stillMissing = [];
for (let f = 0; ; f += 1000) {
  const { data } = await sb.from("products").select("sku, image_filename, image_url").is("image_url", null).range(f, f + 999);
  if (!data) break; stillMissing.push(...data); if (data.length < 1000) break;
}

console.log("\n================ REPORT ================");
console.log("Total image files:        ", files.length, `(${byBase.size} unique)`);
console.log("Uploaded OK:              ", uploaded, upFail ? `(FAILED: ${upFail})` : "");
console.log("Products matched & linked:", matched);
console.log("product_images inserted:  ", piToInsert.length);
console.log("\nUNMATCHED image files (no product with that image_filename):", unmatched.length);
unmatched.slice(0, 50).forEach((u) => console.log("  -", u));
if (unmatched.length > 50) console.log(`  …and ${unmatched.length - 50} more`);
console.log("\nProducts still MISSING image_url:", stillMissing.length);
stillMissing.slice(0, 50).forEach((p) => console.log(`  - sku=${p.sku} image_filename=${p.image_filename ?? "(none)"}`));
if (stillMissing.length > 50) console.log(`  …and ${stillMissing.length - 50} more`);
console.log("\n✓ Done.");
process.exit(0);
