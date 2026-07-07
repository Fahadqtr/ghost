"use server";

import { createClient } from "@/lib/supabase/server";
import { isSignedIn } from "@/lib/auth/requireUser";
import { diffTalabat, talabatEmailText, type TalabatDiff, type TalabatOurRow } from "@/lib/talabat-diff";
import { buildTalabatRows, TALABAT_HEADERS } from "@/lib/malak/talabat-export.mjs";

export type { TalabatDiff } from "@/lib/talabat-diff";

// Talabat has no API — the owner uploads Talabat's own catalog export and we
// diff it against the catalog (options-products excluded: Talabat rejects
// them), then build the "please add these" package: a sheet in the exact
// 10-column Talabat format + the matching images ZIP + a ready email.

const EMPTY_DIFF: TalabatDiff = {
  ok: false, columns: {},
  counts: { ours: 0, eligible: 0, excludedVariants: 0, notApproved: 0, theirRows: 0, matched: 0, missing: 0, extraOnTalabat: 0 },
  missing: [], excludedVariants: [], extraOnTalabat: [],
};

async function pageAll<T>(q: (from: number, to: number) => any): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await q(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as T[]));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

/** READ-ONLY: diff Talabat's uploaded export rows against our catalog. */
export async function computeTalabatDiff(rows: Record<string, unknown>[]): Promise<TalabatDiff> {
  if (!(await isSignedIn())) return { ...EMPTY_DIFF, error: "Not signed in." };
  if (!rows?.length) return { ...EMPTY_DIFF, error: "الملف فاضي — ما فيه صفوف." };

  try {
    const sb = await createClient();
    let prods: Record<string, any>[];
    try {
      prods = await pageAll((from, to) => sb.from("products").select("id, sku, barcode, name_en, name_ar, approval").range(from, to));
    } catch {
      // barcode column may not exist on older installs.
      prods = await pageAll((from, to) => sb.from("products").select("id, sku, name_en, name_ar, approval").range(from, to));
    }
    const parents = new Set<string>();
    try {
      const vars = await pageAll<{ parent_product_id: string }>(
        (from, to) => sb.from("product_variants").select("parent_product_id").range(from, to));
      for (const v of vars) if (v.parent_product_id) parents.add(v.parent_product_id);
    } catch { /* no variants table → nothing excluded */ }

    const ours: TalabatOurRow[] = prods.map((p) => ({
      id: p.id, sku: p.sku ?? null, barcode: p.barcode ?? null,
      name_en: p.name_en ?? null, name_ar: p.name_ar ?? null,
      approval: p.approval ?? null, hasVariants: parents.has(p.id),
    }));
    return diffTalabat(ours, rows.slice(0, 20000));
  } catch (e) {
    return { ...EMPTY_DIFF, error: e instanceof Error ? e.message : "Diff failed." };
  }
}

export interface TalabatPackage {
  ok: boolean;
  error?: string;
  headers: string[];                      // exact Talabat column order
  rows: Record<string, string>[];         // sheet rows, ready for xlsx
  skus: string[];                         // for the images ZIP request
  noImage: { sku: string; name_en: string }[];
  emptyDesc: { sku: string; name_en: string }[];
  emailText: string;
}

/**
 * Build the "add these products" sheet rows (exact Talabat 10-column format)
 * for the given missing products. Pure data back to the client — the browser
 * writes the .xlsx and requests the images ZIP.
 */
export async function buildTalabatPackage(productIds: string[]): Promise<TalabatPackage> {
  const empty = { headers: TALABAT_HEADERS as string[], rows: [], skus: [], noImage: [], emptyDesc: [], emailText: "" };
  if (!(await isSignedIn())) return { ok: false, error: "Not signed in.", ...empty };
  const ids = [...new Set(productIds)].filter(Boolean).slice(0, 2000);
  if (!ids.length) return { ok: false, error: "ما في منتجات محددة.", ...empty };

  try {
    const sb = await createClient();
    const prods: Record<string, any>[] = [];
    for (let i = 0; i < ids.length; i += 200) {
      let sel = "id, sku, barcode, price, discount_price, name_en, name_ar, main_category, description_en, description_ar, image_filename";
      let { data, error } = await sb.from("products").select(sel).in("id", ids.slice(i, i + 200));
      if (error) {
        sel = "id, sku, price, discount_price, name_en, name_ar, main_category, description_en, description_ar, image_filename";
        ({ data, error } = await sb.from("products").select(sel).in("id", ids.slice(i, i + 200)));
      }
      if (error) return { ok: false, error: error.message, ...empty };
      prods.push(...(data ?? []));
    }

    // No variants passed on purpose: options-products never reach Talabat.
    const built = buildTalabatRows(prods, []);
    return {
      ok: true,
      headers: TALABAT_HEADERS as string[],
      rows: built.rows as Record<string, string>[],
      skus: prods.map((p) => String(p.sku ?? "")).filter(Boolean),
      noImage: built.stats.noImage as { sku: string; name_en: string }[],
      emptyDesc: built.stats.stillEmpty as { sku: string; name_en: string }[],
      emailText: talabatEmailText(built.rows.length),
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Package failed.", ...empty };
  }
}
