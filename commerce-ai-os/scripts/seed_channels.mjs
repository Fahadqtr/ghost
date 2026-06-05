// One-time seed of channel_products from the master file's per-channel Status
// columns. Run: node scripts/seed_channels.mjs
//
// Decisions (per owner):
//  • Status values map to our enum 1:1 (Active / Draft / Not Listed).
//  • All four status columns are seeded literally:
//      - Snoonu  -> BOTH "Snoonu" channels (MU + Pure Seoul share one catalog)
//      - Shopify / Talabat / Rafeeq -> their single Malika's Universe channel
//  • Shared single inventory pool: channel_stock is left null (the inventory
//    table is the one source of truth — stock is not duplicated per storefront).
//  • Idempotent: existing (channel_id, product_id) pairs are skipped.
// No schema changes.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const XLSX = require("xlsx");

const FILE = "./Malikas_Universe_CLEAN_28col.xlsx";
const CHUNK = 500;
const ID_CHUNK = 100;
const VALID = new Set(["Active", "Draft", "Not Listed"]);

// File status column -> channel name in the DB.
const COLUMN_TO_CHANNEL = {
  "Shopify Status": "Shopify",
  "Snoonu Status": "Snoonu",
  "Talabat Status": "Talabat",
  "Rafeeq Status": "Rafeeq",
};

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
if (!env.SUPABASE_SERVICE_ROLE_KEY) { console.error("✗ SUPABASE_SERVICE_ROLE_KEY missing in .env.local"); process.exit(1); }

async function retryingFetch(u, o, tries = 5) {
  let last;
  for (let i = 0; i < tries; i++) { try { return await fetch(u, o); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 400 * 2 ** i)); } }
  throw last;
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }, global: { fetch: (u, o) => retryingFetch(u, o) },
});

const S = (v) => { const t = String(v ?? "").trim(); return t === "" ? null : t; };
const N = (v) => { const t = String(v ?? "").trim(); if (t === "") return null; const n = Number(t); return isNaN(n) ? null : n; };
const chunks = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
const die = (label, error) => { if (error) { console.error(`✗ ${label}:`, error.message ?? error); process.exit(1); } };

const rows = XLSX.utils.sheet_to_json(XLSX.readFile(FILE).Sheets["Import"], { defval: "" });
console.log(`Loaded ${rows.length} rows`);

// channels: name -> [ids]
const { data: channels, error: chErr } = await sb.from("channels").select("id, name");
die("read channels", chErr);
const channelIds = {};
for (const c of channels) (channelIds[c.name] ??= []).push(c.id);
console.log("Channels:", Object.entries(channelIds).map(([n, ids]) => `${n}×${ids.length}`).join(", "));

// products: sku -> { id, price, stock }
const fileSkus = rows.map((r) => S(r.SKU)).filter(Boolean);
const prod = new Map();
for (const part of chunks(fileSkus, CHUNK)) {
  const { data, error } = await sb.from("products").select("id, sku, price, stock_quantity").in("sku", part);
  die("read products", error);
  data.forEach((p) => prod.set(p.sku, p));
}
console.log(`Resolved ${prod.size} products`);

// Build desired channel_products rows from non-default statuses.
const targetChannelIds = new Set();
let desired = [];
for (const r of rows) {
  const sku = S(r.SKU);
  const p = sku && prod.get(sku);
  if (!p) continue;
  for (const [col, chName] of Object.entries(COLUMN_TO_CHANNEL)) {
    const status = S(r[col]);
    if (!status) continue; // only truly-blank cells are skipped
    if (!VALID.has(status)) { console.warn(`  ! unexpected status "${status}" in ${col} (sku ${sku}) — skipped`); continue; }
    for (const cid of channelIds[chName] ?? []) {
      targetChannelIds.add(cid);
      // Shared single inventory pool -> do NOT duplicate stock per storefront.
      desired.push({ channel_id: cid, product_id: p.id, channel_status: status, channel_price: p.price, channel_stock: null });
    }
  }
}
console.log(`Desired rows (non-default): ${desired.length}`);

// Idempotency: drop pairs that already exist on the target channels.
const existing = new Set();
for (const cid of targetChannelIds) {
  const ids = [...prod.values()].map((p) => p.id);
  for (const part of chunks(ids, ID_CHUNK)) {
    const { data, error } = await sb.from("channel_products").select("product_id").eq("channel_id", cid).in("product_id", part);
    die("read channel_products", error);
    data.forEach((r) => existing.add(`${cid}:${r.product_id}`));
  }
}
const toInsert = desired.filter((d) => !existing.has(`${d.channel_id}:${d.product_id}`));
console.log(`${desired.length - toInsert.length} already present (skipped), ${toInsert.length} to insert`);
for (const part of chunks(toInsert, CHUNK)) die("insert channel_products", (await sb.from("channel_products").insert(part)).error);

// Report counts per channel.
console.log("\nchannel_products counts per channel:");
for (const c of channels) {
  const { count } = await sb.from("channel_products").select("*", { count: "exact", head: true }).eq("channel_id", c.id);
  console.log(`  ${c.name.padEnd(10)} ${String(count).padStart(5)}   (${c.id})`);
}
const { count: total } = await sb.from("channel_products").select("*", { count: "exact", head: true });
console.log(`  TOTAL      ${String(total).padStart(5)}`);
console.log("\n✓ Channel seed complete.");
