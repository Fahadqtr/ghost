// Full-catalog Compliance audit (read-only on products; writes a verdict
// baseline into compliance_log). Uses the committed deterministic engine.
//
// Run (from commerce-ai-os/):
//   NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//   node --experimental-strip-types scripts/run-compliance-audit.ts
//
//   DRY_RUN=1  → compute + print the summary, write NOTHING (preview first).
//
// It never touches the products table. Service-role is required (bypasses RLS
// to read all products and insert into compliance_log).

import { createClient } from "@supabase/supabase-js";
import { runChecks, DEFAULT_RULES } from "../lib/compliance/checker.ts";
import { buildPlatformPrices } from "../lib/compliance/priceContext.ts";
import type { Draft, RulesConfig, Verdict } from "../lib/compliance/types.ts";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRY = process.env.DRY_RUN === "1";
if (!URL || !KEY) {
  console.error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}
const db = createClient(URL, KEY, { auth: { persistSession: false } });
const PAGE = 1000;

async function loadRules(): Promise<RulesConfig> {
  const { data, error } = await db.from("compliance_rules").select("rule_key, rule_value, active");
  if (error) throw new Error(`compliance_rules unreadable: ${error.message}`);
  if (!data || data.length === 0) throw new Error("compliance_rules empty — fail closed (refusing to run).");
  const m = new Map<string, unknown>();
  for (const r of data as { rule_key: string; rule_value: unknown; active: boolean }[]) if (r.active) m.set(r.rule_key, r.rule_value);
  const g = <T>(k: string, d: T): T => (m.has(k) ? (m.get(k) as T) : d);
  return {
    valid_categories: g("valid_categories", DEFAULT_RULES.valid_categories),
    forbidden_terms_en: g("forbidden_terms_en", DEFAULT_RULES.forbidden_terms_en),
    forbidden_terms_ar: g("forbidden_terms_ar", DEFAULT_RULES.forbidden_terms_ar),
    format_rules: g("format_rules", DEFAULT_RULES.format_rules),
    fabrication_patterns: g("fabrication_patterns", DEFAULT_RULES.fabrication_patterns),
    category_fallback: g("category_fallback", DEFAULT_RULES.category_fallback),
    on_label_claims: g("on_label_claims", DEFAULT_RULES.on_label_claims),
    image_rules: g("image_rules", DEFAULT_RULES.image_rules),
  };
}

async function pageAll<T>(table: string, columns: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db.from(table).select(columns).range(from, from + PAGE - 1);
    if (error) throw new Error(`${table} read failed: ${error.message}`);
    if (!data || data.length === 0) break;
    out.push(...(data as T[]));
    if (data.length < PAGE) break;
  }
  return out;
}

type ProductRow = {
  id: string; sku: string | null; name_en: string | null; name_ar: string | null;
  main_category: string | null; description_en: string | null; description_ar: string | null;
  keywords_en: string | null; keywords_ar: string | null; size: string | null;
  price: number | null; discount_price: number | null; image_url: string | null;
};

async function main() {
  console.log(`Compliance audit ${DRY ? "(DRY RUN — no writes)" : "(writing baseline to compliance_log)"}`);
  const rules = await loadRules();

  // channel name map + channel_products grouped by product (for platform_prices)
  const channels = await pageAll<{ id: string; name: string }>("channels", "id, name");
  const chName = new Map(channels.map((c) => [c.id, c.name]));
  const cps = await pageAll<{ product_id: string; channel_id: string; channel_price: number | null }>(
    "channel_products", "product_id, channel_id, channel_price"
  );
  const byProduct = new Map<string, { channel: string; channel_price: number | null }[]>();
  for (const cp of cps) {
    const arr = byProduct.get(cp.product_id) ?? [];
    arr.push({ channel: chName.get(cp.channel_id) ?? cp.channel_id, channel_price: cp.channel_price });
    byProduct.set(cp.product_id, arr);
  }

  const products = await pageAll<ProductRow>(
    "products",
    "id, sku, name_en, name_ar, main_category, description_en, description_ar, keywords_en, keywords_ar, size, price, discount_price, image_url"
  );

  const verdicts: { p: ProductRow; v: Verdict }[] = [];
  for (const p of products) {
    if (!p.sku) continue;
    const rows = byProduct.get(p.id) ?? [];
    const draft: Draft = {
      sku: p.sku, title_en: p.name_en, title_ar: p.name_ar, name_en: p.name_en, name_ar: p.name_ar,
      main_category: p.main_category, desc_en: p.description_en, desc_ar: p.description_ar,
      keywords_en: p.keywords_en, keywords_ar: p.keywords_ar, size: p.size, price: p.price,
      discount_price: p.discount_price, image_url: p.image_url,
      platform_prices: rows.length ? buildPlatformPrices(rows, p.price ?? null) : undefined,
    };
    verdicts.push({ p, v: runChecks(draft, rules) });
  }

  // ---- write baseline ----
  if (!DRY) {
    const stamp = new Date().toISOString();
    const rows = verdicts.map(({ v }) => ({
      product_sku: v.sku, overall: v.overall, publish_allowed: v.publish_allowed, needs_human: v.needs_human,
      failed_checks: v.checks.filter((c) => c.severity !== "PASS"), checker_version: "v1",
      notes: `full_catalog_baseline ${stamp}`,
    }));
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await db.from("compliance_log").insert(rows.slice(i, i + 500));
      if (error) throw new Error(`compliance_log insert failed at ${i}: ${error.message}`);
      console.log(`  wrote ${Math.min(i + 500, rows.length)}/${rows.length}`);
    }
  }

  // ---- summary ----
  const total = verdicts.length;
  const overall = { PASS: 0, WARN: 0, BLOCK: 0 };
  const reasons = new Map<string, number>();
  const sub = { missing_size: 0, keywords_en: 0, keywords_ar: 0, missing_desc_or_name: 0 };
  const byCat = new Map<string, { PASS: number; WARN: number; BLOCK: number; total: number }>();
  const blocks: { sku: string; why: string }[] = [];

  for (const { p, v } of verdicts) {
    overall[v.overall]++;
    const cat = p.main_category ?? "(none)";
    const cc = byCat.get(cat) ?? { PASS: 0, WARN: 0, BLOCK: 0, total: 0 };
    cc[v.overall]++; cc.total++; byCat.set(cat, cc);
    for (const c of v.checks) {
      if (c.severity === "PASS") continue;
      reasons.set(c.name, (reasons.get(c.name) ?? 0) + 1);
      if (c.name === "required_fields") {
        const e = c.evidence ?? "";
        if (/\bsize\b/.test(e)) sub.missing_size++;
        if (/keywords_en/.test(e)) sub.keywords_en++;
        if (/keywords_ar/.test(e)) sub.keywords_ar++;
        if (/name_|desc_/.test(e)) sub.missing_desc_or_name++;
      }
    }
    if (v.overall === "BLOCK") {
      blocks.push({ sku: v.sku, why: v.checks.filter((c) => c.severity === "BLOCK").map((c) => `${c.name}${c.evidence ? `(${c.evidence})` : ""}`).join("; ") });
    }
  }

  const pct = (n: number) => total ? ((100 * n) / total).toFixed(1) + "%" : "0%";
  console.log(`\n================ COMPLIANCE AUDIT SUMMARY ================`);
  console.log(`Total products scored: ${total}`);
  console.log(`\n1) TOTALS:`);
  console.log(`   PASS  ${overall.PASS}  (${pct(overall.PASS)})`);
  console.log(`   WARN  ${overall.WARN}  (${pct(overall.WARN)})`);
  console.log(`   BLOCK ${overall.BLOCK}  (${pct(overall.BLOCK)})`);
  console.log(`\n2) TOP REASONS (checks fired, product count):`);
  for (const [name, n] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) console.log(`   ${name.padEnd(18)} ${n}`);
  console.log(`   -- required_fields breakdown --`);
  console.log(`   missing size:        ${sub.missing_size}`);
  console.log(`   keywords_en off:     ${sub.keywords_en}`);
  console.log(`   keywords_ar off:     ${sub.keywords_ar}`);
  console.log(`   missing name/desc:   ${sub.missing_desc_or_name}`);
  console.log(`\n3) BLOCK LIST (${blocks.length} cannot publish):`);
  if (blocks.length === 0) console.log(`   (none)`);
  else for (const b of blocks) console.log(`   ${b.sku.padEnd(12)} ${b.why}`);
  console.log(`\n4) BY CATEGORY (worst data quality first):`);
  const cats = [...byCat.entries()].sort((a, b) => (b[1].BLOCK + b[1].WARN) / b[1].total - (a[1].BLOCK + a[1].WARN) / a[1].total);
  console.log(`   category                         total  PASS  WARN  BLOCK  %clean`);
  for (const [cat, c] of cats) {
    const clean = ((100 * c.PASS) / c.total).toFixed(0) + "%";
    console.log(`   ${cat.padEnd(32)} ${String(c.total).padStart(5)} ${String(c.PASS).padStart(5)} ${String(c.WARN).padStart(5)} ${String(c.BLOCK).padStart(6)}  ${clean.padStart(5)}`);
  }

  // ---- Arabic summary ----
  console.log(`\n================ ملخّص عربي ================`);
  console.log(`إجمالي المنتجات: ${total}`);
  console.log(`النتائج: PASS=${overall.PASS} (${pct(overall.PASS)}) | WARN=${overall.WARN} (${pct(overall.WARN)}) | BLOCK=${overall.BLOCK} (${pct(overall.BLOCK)})`);
  console.log(`أكثر الأسباب: ${[...reasons.entries()].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n}=${c}`).join(" ، ")}`);
  console.log(`نقص size=${sub.missing_size} | كلمات إنجليزي=${sub.keywords_en} | كلمات عربي=${sub.keywords_ar}`);
  console.log(`محظور النشر (BLOCK): ${blocks.length}${blocks.length ? " → " + blocks.map((b) => b.sku).join(", ") : ""}`);
  console.log(`${DRY ? "(DRY RUN — لم تُكتب أي verdicts)" : "تم تسجيل النتائج في compliance_log كـbaseline."}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
