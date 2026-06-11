"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

// Pure Seoul is an INDEPENDENT platform selling the same products as Malika. Its
// approval/rejection lives in the shared `platform_status` overlay (platform =
// 'pure_seoul') — writing here NEVER touches products.approval (Malika's master)
// nor any other platform. See app/(app)/platforms/actions.ts for the table DDL.
const PS = "pure_seoul";

// Upsert a Pure-Seoul-only approval/rejection for the given product ids. An
// empty approval clears the row's status; reason is stored as its own field.
export async function setPureSeoulApproval(ids: string[], approval: string, reason?: string) {
  const { data: { user } } = await createClient().auth.getUser();
  if (!user) return { error: "غير مسجّل الدخول.", updated: 0 };
  const list = (ids ?? []).filter(Boolean);
  if (list.length === 0) return { error: "ما في منتجات محدّدة.", updated: 0 };
  const sb = createClient();
  const now = new Date().toISOString();
  const rows = list.map((product_id) => ({
    product_id,
    platform: PS,
    approval: approval === "" ? null : approval,
    rejection_reason: reason !== undefined ? (reason.trim() || null) : null,
    updated_at: now,
  }));
  let updated = 0, failed = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const { error } = await sb.from("platform_status").upsert(chunk, { onConflict: "product_id,platform" });
    if (error) failed += chunk.length; else updated += chunk.length;
  }
  revalidatePath("/import-export/pure-seoul");
  revalidatePath("/platforms/pure_seoul");
  return { ok: failed === 0, updated, failed };
}

// Convenience wrapper for the screenshot/paste reject tool on the Pure Seoul page.
export async function rejectPureSeoulProducts(ids: string[], reason: string) {
  return setPureSeoulApproval(ids, "Rejected", reason);
}

export interface PSRejected {
  id: string;
  sku: string | null;
  name_en: string | null;
  category: string | null;
  reason: string | null;
  updated_at: string | null;
}

// List products currently rejected on Pure Seoul (independent of Malika). Reads
// the standalone status table and joins the product's display fields.
export async function getPureSeoulRejected(): Promise<PSRejected[]> {
  const sb = createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return [];
  const { data, error } = await sb
    .from("platform_status")
    .select("product_id, rejection_reason, updated_at, products(sku, name_en, main_category)")
    .eq("platform", PS)
    .eq("approval", "Rejected")
    .order("updated_at", { ascending: false });
  if (error || !data) return [];
  return data.map((r: any) => ({
    id: r.product_id,
    sku: r.products?.sku ?? null,
    name_en: r.products?.name_en ?? null,
    category: r.products?.main_category ?? null,
    reason: r.rejection_reason ?? null,
    updated_at: r.updated_at ?? null,
  }));
}

// One parsed row from a Pure Seoul "NonFoodProducts" export.
export interface PSRow {
  id?: string;
  global_id?: string;
  name_en?: string;
  name_ar?: string;
  price?: string;
  approval?: string;
  branchStatus?: string;
  stock?: string;          // "Stock for …" quantity, when the export has it
}

export interface PSItem {
  sku: string | null;
  name_en: string | null;
  price?: string | number | null;   // Malika price (correct)
  psPrice?: string | null;          // Pure Seoul price
  category?: string | null;
  psName?: string | null;           // closest Pure Seoul name (for review pairs)
  score?: number;                   // match confidence for review pairs
  psStock?: number | null;          // Pure Seoul stock quantity
}

export interface PSCompare {
  ok: boolean;
  error?: string;
  counts: {
    psRows: number;
    matched: number;
    missingOnPS: number;   // confident: in Malika, no match nor close name on PS → ADD
    reviewOnPS: number;    // a close PS name exists (likely same / size-variant) → review
    extraOnPS: number;
    priceDiffs: number;
    psRejected: number;
    psInactive: number;
    psInStock: number;     // present on PS with stock > 0
    psOutOfStock: number;  // present on PS but finished (stock <= 0) — مخلّصة
  };
  hasStock: boolean;       // whether the export carried a Stock column
  missingOnPS: PSItem[];   // confident missing
  reviewOnPS: PSItem[];    // needs human review (name/size variants)
  extraOnPS: PSItem[];
  priceDiffs: PSItem[];
  psInStock: PSItem[];     // موجودة ومتوفّرة
  psOutOfStock: PSItem[];  // مخلّصة (نافدة)
}

const S = (v: unknown) => String(v ?? "").trim();
// Aggressive normalization for name matching: lowercase + keep only letters/
// digits (drops spaces, dashes, parens, apostrophes, units punctuation). This
// matches name variants like "Body Cream" = "BodyCream", "(100g)" = "100g"
// without hiding genuinely-missing products (it only matches when alnum-identical).
const norm = (s: unknown) => S(s).toLowerCase().replace(/[^a-z0-9]/g, "");
const tokens = (s: unknown) => new Set(S(s).toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2));
// Token set that KEEPS numeric tokens (sizes/counts) even when short — numbers
// are the discriminator between "6 Color" and "10 Color". Words must be ≥3 chars.
const tokset = (s: unknown) => new Set(
  S(s).toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length >= 3 || /^[0-9]+$/.test(w))
);
// True when `a` is fully contained in `b` (same product, b just has extra
// size/qualifier words). Requires ≥3 shared tokens to avoid generic over-match,
// and — since tokset keeps numbers — guarantees a's sizes/counts all exist in b.
const isSubset = (a: Set<string>, b: Set<string>) => {
  if (a.size < 3) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
};
const jaccard = (a: Set<string>, b: Set<string>) => { let i = 0; for (const x of a) if (b.has(x)) i++; return i / (a.size + b.size - i || 1); };
const numEq = (a: unknown, b: unknown) => {
  const x = Number(a), y = Number(b);
  if (isNaN(x) || isNaN(y)) return S(a) === S(b);
  return x === y;
};

// Compare a Pure Seoul export against the Malika master catalog. Read-only.
// Matches PS→Malika by global_id (= our snoonu_id) then by name_en.
export async function comparePureSeoul(rows: PSRow[]): Promise<PSCompare> {
  const empty: PSCompare = {
    ok: false,
    counts: { psRows: 0, matched: 0, missingOnPS: 0, reviewOnPS: 0, extraOnPS: 0, priceDiffs: 0, psRejected: 0, psInactive: 0, psInStock: 0, psOutOfStock: 0 },
    hasStock: false,
    missingOnPS: [], reviewOnPS: [], extraOnPS: [], priceDiffs: [], psInStock: [], psOutOfStock: [],
  };
  if (!rows?.length) return { ...empty, error: "ما في صفوف في الملف." };

  try {
    const sb = createClient();
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return { ...empty, error: "غير مسجّل الدخول." };

    const all: any[] = [];
    for (let f = 0; ; f += 1000) {
      const { data, error } = await sb.from("products")
        .select("snoonu_id, sku, name_en, price, main_category").range(f, f + 999);
      if (error) return { ...empty, error: error.message };
      all.push(...(data ?? []));
      if ((data ?? []).length < 1000) break;
    }

    const byId = new Map<string, any>();
    for (const p of all) if (S(p.snoonu_id)) byId.set(S(p.snoonu_id), p);
    const byName = new Map<string, any>();
    for (const p of all) { const n = norm(p.name_en); if (n) byName.set(n, p); }

    const matchedMalika = new Set<any>();
    const extraOnPS: PSItem[] = [];
    const priceDiffs: PSItem[] = [];
    const psInStock: PSItem[] = [];
    const psOutOfStock: PSItem[] = [];
    let matched = 0, psRejected = 0, psInactive = 0;
    // Pure Seoul has NO quantity system: a HIDDEN product (Availability = False /
    // branchStatus inactive) IS the out-of-stock (مخلّصة) signal. So classify by
    // availability, not by any stock number.
    const hasStock = rows.some((r) => { const b = S(r.branchStatus).toLowerCase(); return b === "active" || b === "inactive"; });

    for (const r of rows) {
      if (S(r.approval) === "Rejected") psRejected++;
      const bs = S(r.branchStatus).toLowerCase();
      if (bs === "inactive") psInactive++;
      const m = byId.get(S(r.global_id)) || byName.get(norm(r.name_en));
      if (m) {
        matched++;
        matchedMalika.add(m);
        if (!numEq(r.price, m.price)) {
          priceDiffs.push({ sku: m.sku ?? null, name_en: m.name_en ?? null, psPrice: S(r.price) || null, price: m.price ?? null });
        }
      } else {
        extraOnPS.push({ sku: null, name_en: S(r.name_en) || null, psPrice: S(r.price) || null });
      }
      // Present (موجودة) vs hidden = out of stock (مخلّصة).
      if (hasStock) {
        const item: PSItem = {
          sku: m?.sku ?? null,
          name_en: S(r.name_en) || (m?.name_en ?? null),
          psPrice: S(r.price) || null,
        };
        if (bs === "inactive") psOutOfStock.push(item);
        else if (bs === "active") psInStock.push(item);
      }
    }

    // Split the unmatched Malika products into "confident missing" (no close PS
    // name) vs "review" (a similar PS name exists — likely the same item or a
    // size/shade variant). Names alone can't be 100% (e.g. "6 Color" vs "10
    // Color"), so the review bucket is surfaced for a human to confirm.
    // Pre-compute PS token sets (numbers kept) for subset + similarity passes.
    const psTok = rows.map((r) => ({ t: tokset(r.name_en), n: S(r.name_en) })).filter((x) => x.t.size);
    const missingOnPS: PSItem[] = [];
    const reviewOnPS: PSItem[] = [];
    for (const p of all) {
      if (matchedMalika.has(p)) continue;
      const pt = tokset(p.name_en);
      // Subset auto-match: one name fully contains the other (extra size/qualifier
      // words only) AND all numeric tokens align → same product, count as matched.
      let sub = false;
      let best = 0, bn = "";
      if (pt.size) for (const x of psTok) {
        if (!sub && (isSubset(pt, x.t) || isSubset(x.t, pt))) { sub = true; bn = x.n; best = 1; break; }
        const s = jaccard(pt, x.t); if (s > best) { best = s; bn = x.n; }
      }
      if (sub) { matched++; matchedMalika.add(p); continue; }
      const base = { sku: p.sku ?? null, name_en: p.name_en ?? null, price: p.price ?? null, category: p.main_category ?? null };
      if (best >= 0.55) reviewOnPS.push({ ...base, psName: bn, score: Math.round(best * 100) / 100 });
      else missingOnPS.push(base);
    }
    reviewOnPS.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

    return {
      ok: true,
      counts: {
        psRows: rows.length,
        matched,
        missingOnPS: missingOnPS.length,
        reviewOnPS: reviewOnPS.length,
        extraOnPS: extraOnPS.length,
        priceDiffs: priceDiffs.length,
        psRejected,
        psInactive,
        psInStock: psInStock.length,
        psOutOfStock: psOutOfStock.length,
      },
      hasStock,
      missingOnPS: missingOnPS.slice(0, 500),
      reviewOnPS: reviewOnPS.slice(0, 500),
      extraOnPS: extraOnPS.slice(0, 500),
      priceDiffs: priceDiffs.slice(0, 500),
      psInStock: psInStock.slice(0, 500),
      psOutOfStock: psOutOfStock.slice(0, 1000),
    };
  } catch (e) {
    return { ...empty, error: e instanceof Error ? e.message : "خطأ غير متوقع." };
  }
}
