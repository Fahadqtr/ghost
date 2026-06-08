// One-time cleanup of messy category names in products.main_category.
//
// Writes ONLY products.main_category (for matching rows). Because there is a
// foreign key products.main_category -> product_categories(name), the target
// name must exist in product_categories first; so this also adds the clean
// name to that lookup table and removes the old orphaned one. No other PRODUCT
// field is ever touched.
//
// Renames:
//   "✨Toys" -> "Toys"   (strip emoji + trim)
//
// "Women’s Essentials" is intentionally left as-is: an apostrophe never breaks
// CSV (only comma/quote/newline are quoted), so the name stays unchanged.
//
// Usage:
//   node scripts/clean_categories.mjs           # dry-run (plan only)
//   node scripts/clean_categories.mjs --apply    # writes

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");

// [oldName, newName]
const RENAMES = [
  ["✨Toys", "Toys"],
];

const env = {};
readFileSync(".env.local", "utf8").split("\n").forEach((l) => {
  const i = l.indexOf("="); if (i > 0 && !l.trim().startsWith("#")) env[l.slice(0, i).trim()] = l.slice(i + 1).trim();
});
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

async function countCat(name) {
  const { count } = await sb.from("products").select("*", { count: "exact", head: true }).eq("main_category", name);
  return count ?? 0;
}

console.log(APPLY ? "APPLYING category cleanup…\n" : "DRY-RUN (no writes). Re-run with --apply.\n");

for (const [oldName, newName] of RENAMES) {
  const n = await countCat(oldName);
  console.log(`"${oldName}" → "${newName}":  ${n} product(s)`);
  if (!APPLY) continue;

  // 1) Ensure the clean name exists in the lookup table (FK target).
  const { data: existing } = await sb.from("product_categories").select("name").eq("name", newName);
  if (!existing || existing.length === 0) {
    const { error } = await sb.from("product_categories").insert({ name: newName });
    if (error) { console.error(`  ✗ insert "${newName}" into product_categories:`, error.message); process.exit(1); }
    console.log(`  ✓ added "${newName}" to product_categories`);
  } else {
    console.log(`  • "${newName}" already in product_categories`);
  }

  // 2) Update ONLY main_category on the matching product rows.
  const { error: upErr, count } = await sb.from("products")
    .update({ main_category: newName }, { count: "exact" })
    .eq("main_category", oldName);
  if (upErr) { console.error(`  ✗ update products:`, upErr.message); process.exit(1); }
  console.log(`  ✓ updated ${count ?? n} product(s): main_category only`);

  // 3) Remove the now-orphaned old category from the lookup table.
  const remaining = await countCat(oldName);
  if (remaining === 0) {
    const { error: delErr } = await sb.from("product_categories").delete().eq("name", oldName);
    if (delErr) console.warn(`  ⚠ could not delete old "${oldName}" from product_categories: ${delErr.message}`);
    else console.log(`  ✓ removed orphaned "${oldName}" from product_categories`);
  } else {
    console.log(`  ⚠ ${remaining} product(s) still reference "${oldName}" — kept it`);
  }
}

// Final distinct category list from products.
const all = [];
for (let f = 0; ; f += 1000) {
  const { data } = await sb.from("products").select("main_category").range(f, f + 999);
  all.push(...data); if (data.length < 1000) break;
}
const m = {};
for (const p of all) { const c = (p.main_category ?? "").toString(); m[c] = (m[c] || 0) + 1; }
console.log(`\nDistinct categories now: ${Object.keys(m).length}`);
for (const [c, n] of Object.entries(m).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${JSON.stringify(c)}`);
