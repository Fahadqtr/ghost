#!/usr/bin/env node
// CH.5 — READ-ONLY backfill report generator.
//
// Projects the current identity sources into candidate external_channel_listings
// rows and prints a conflict report. READ-ONLY: it issues only SELECTs and writes
// nothing. Run this during the APPROVED production apply (step B), BEFORE any
// backfill insert, to prove the data migrates deterministically.
//
// Usage (requires env):
//   NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//   node --experimental-strip-types scripts/ch5_backfill_report.mjs
//
// It reuses the SAME pure projection the tests cover (lib/channels/
// external-listing-backfill.ts), so the report matches the code exactly.

import { createClient } from "@supabase/supabase-js";
import { projectBackfill } from "../lib/channels/external-listing-backfill.ts";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — read-only report aborted.");
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false } });

async function pageAll(select) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await select(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

const products = await pageAll((f, t) =>
  sb.from("products").select("id, snoonu_id, pure_seoul_id, rafeeq_product_id").range(f, t),
);

// channel_variant_mappings joined to channels.name (read-only).
const channels = await pageAll((f, t) => sb.from("channels").select("id, name").range(f, t));
const nameById = new Map(channels.map((c) => [String(c.id), c.name ?? null]));
const cvmRaw = await pageAll((f, t) =>
  sb.from("channel_variant_mappings")
    .select("channel_id, master_product_id, master_variant_sku, exported_sku, exported_barcode, channel_product_id, mapping_status")
    .range(f, t),
);
const variantMappings = cvmRaw.map((m) => ({
  channel_name: nameById.get(String(m.channel_id)) ?? null,
  master_product_id: m.master_product_id,
  master_variant_sku: m.master_variant_sku,
  exported_sku: m.exported_sku,
  exported_barcode: m.exported_barcode,
  channel_product_id: m.channel_product_id,
  mapping_status: m.mapping_status,
}));

const { records, report } = projectBackfill(products, variantMappings);

console.log(JSON.stringify({
  inputs: { products: products.length, channels: channels.length, variantMappings: variantMappings.length },
  candidates: records.length,
  report,
}, null, 2));
console.log(`\nNEEDS_REVIEW rows: ${report.needsReview} — do NOT insert these as active; a human decides.`);
console.log(report.conflicts === 0
  ? "No conflicts — backfill can proceed after approval."
  : `${report.conflicts} conflict group(s) — resolve or mark needs_review before switching the resolver.`);
