"use server";

import { createClient } from "@/lib/supabase/server";

// One parsed row from a Pure Seoul "NonFoodProducts" export.
export interface PSRow {
  id?: string;
  global_id?: string;
  name_en?: string;
  name_ar?: string;
  price?: string;
  approval?: string;
  branchStatus?: string;
}

export interface PSItem {
  sku: string | null;
  name_en: string | null;
  price?: string | number | null;   // Malika price (correct)
  psPrice?: string | null;          // Pure Seoul price
  category?: string | null;
}

export interface PSCompare {
  ok: boolean;
  error?: string;
  counts: {
    psRows: number;
    matched: number;
    missingOnPS: number;   // in Malika (master), not on Pure Seoul → ADD to PS
    extraOnPS: number;     // on Pure Seoul, not in Malika → review/remove
    priceDiffs: number;    // matched, price differs
    psRejected: number;    // Rejected on Pure Seoul (from file)
    psInactive: number;    // branchStatus = inactive (hidden) on Pure Seoul
  };
  missingOnPS: PSItem[];
  extraOnPS: PSItem[];
  priceDiffs: PSItem[];
}

const S = (v: unknown) => String(v ?? "").trim();
// Aggressive normalization for name matching: lowercase + keep only letters/
// digits (drops spaces, dashes, parens, apostrophes, units punctuation). This
// matches name variants like "Body Cream" = "BodyCream", "(100g)" = "100g"
// without hiding genuinely-missing products (it only matches when alnum-identical).
const norm = (s: unknown) => S(s).toLowerCase().replace(/[^a-z0-9]/g, "");
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
    counts: { psRows: 0, matched: 0, missingOnPS: 0, extraOnPS: 0, priceDiffs: 0, psRejected: 0, psInactive: 0 },
    missingOnPS: [], extraOnPS: [], priceDiffs: [],
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
    let matched = 0, psRejected = 0, psInactive = 0;

    for (const r of rows) {
      if (S(r.approval) === "Rejected") psRejected++;
      if (S(r.branchStatus).toLowerCase() === "inactive") psInactive++;
      const m = byId.get(S(r.global_id)) || byName.get(norm(r.name_en));
      if (!m) { extraOnPS.push({ sku: null, name_en: S(r.name_en) || null, psPrice: S(r.price) || null }); continue; }
      matched++;
      matchedMalika.add(m);
      if (!numEq(r.price, m.price)) {
        priceDiffs.push({ sku: m.sku ?? null, name_en: m.name_en ?? null, psPrice: S(r.price) || null, price: m.price ?? null });
      }
    }

    const missingOnPS: PSItem[] = all
      .filter((p) => !matchedMalika.has(p))
      .map((p) => ({ sku: p.sku ?? null, name_en: p.name_en ?? null, price: p.price ?? null, category: p.main_category ?? null }));

    return {
      ok: true,
      counts: {
        psRows: rows.length,
        matched,
        missingOnPS: missingOnPS.length,
        extraOnPS: extraOnPS.length,
        priceDiffs: priceDiffs.length,
        psRejected,
        psInactive,
      },
      missingOnPS: missingOnPS.slice(0, 500),
      extraOnPS: extraOnPS.slice(0, 500),
      priceDiffs: priceDiffs.slice(0, 500),
    };
  } catch (e) {
    return { ...empty, error: e instanceof Error ? e.message : "خطأ غير متوقع." };
  }
}
