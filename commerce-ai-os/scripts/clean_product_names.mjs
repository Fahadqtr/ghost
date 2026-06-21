// Clean emojis/decorative symbols out of product names in the DB so they're
// clean everywhere (Product Hub, Malak, exports). Uses the SAME clean() as the
// Talabat export (single source of truth).
//
// Writes ONLY name_en / name_ar, ONLY for rows that actually change. Touches no
// other field.
//
// Usage:
//   node scripts/clean_product_names.mjs           # dry-run (shows before→after)
//   node scripts/clean_product_names.mjs --apply    # writes

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { clean } from "../lib/malak/talabat-export.mjs";

const APPLY = process.argv.includes("--apply");

const env = {};
readFileSync(".env.local", "utf8").split("\n").forEach((l) => {
  const i = l.indexOf("="); if (i > 0 && !l.trim().startsWith("#")) env[l.slice(0, i).trim()] = l.slice(i + 1).trim();
});
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const S = (v) => (v == null ? "" : String(v));

const all = [];
for (let f = 0; ; f += 1000) {
  const { data, error } = await sb.from("products").select("id, sku, name_en, name_ar").range(f, f + 999);
  if (error) { console.error("✗ read:", error.message); process.exit(1); }
  all.push(...data); if (data.length < 1000) break;
}

const changes = [];
for (const p of all) {
  const en = S(p.name_en), ar = S(p.name_ar);
  const cEn = clean(en), cAr = clean(ar);
  const patch = {};
  if (cEn !== en) patch.name_en = cEn;
  if (cAr !== ar) patch.name_ar = cAr;
  if (Object.keys(patch).length) changes.push({ id: p.id, sku: p.sku, en, cEn, ar, cAr, patch });
}

console.log(`${APPLY ? "APPLYING" : "DRY-RUN"} — products needing a name cleanup: ${changes.length}\n`);
for (const c of changes) {
  if ("name_en" in c.patch) console.log(`${c.sku} EN: "${c.en}"  →  "${c.cEn}"`);
  if ("name_ar" in c.patch) console.log(`${c.sku} AR: "${c.ar}"  →  "${c.cAr}"`);
}

if (!APPLY) { console.log("\n(dry-run) Re-run with --apply to write."); process.exit(0); }

let ok = 0, fail = 0;
for (const c of changes) {
  const { error } = await sb.from("products").update(c.patch).eq("id", c.id);
  if (error) { fail++; console.error(`✗ ${c.sku}:`, error.message); } else ok++;
}
console.log(`\nUpdated ${ok} product(s)${fail ? `, ${fail} failed` : ""} (name_en/name_ar only).`);

// Verify nothing emoji-ish remains in names.
const after = [];
for (let f = 0; ; f += 1000) {
  const { data } = await sb.from("products").select("sku, name_en, name_ar").range(f, f + 999);
  after.push(...data); if (data.length < 1000) break;
}
const RE = /[\u{1F000}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2300}-\u{23FF}\u{25A0}-\u{25FF}]/u;
const left = after.filter((p) => RE.test(S(p.name_en)) || RE.test(S(p.name_ar)));
console.log(`Names still containing emoji/symbol: ${left.length} ${left.length === 0 ? "✅" : "🔴 " + left.map((p) => p.sku).join(", ")}`);
