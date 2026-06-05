"use server";

import { createClient } from "@/lib/supabase/server";

// One parsed row from the Snoonu export (sheet "NonFoodProducts").
export interface SnoonuExportRow {
  id: string;
  name_en?: string;
  name_ar?: string;
  description_en?: string;
  description_ar?: string;
  price?: string;
  discount?: string;
  approval?: string;
  is_featured?: string;
  is_promoted?: string;
  has_buy1get1?: string;
}

export interface FieldChange { field: string; old: string; new: string }
export interface UpdatedEntry { snoonu_id: string; product_id: string; name_en: string; changes: FieldChange[] }
export interface NewEntry { id: string; name_en: string }
export interface MissingEntry { snoonu_id: string; product_id: string; sku: string | null; name_en: string | null }

export interface SnoonuDiff {
  ok: boolean;
  error?: string;
  existingOptionalCols: string[];
  missingOptionalCols: string[];
  counts: { exportRows: number; matched: number; updated: number; newCount: number; missing: number; unchanged: number };
  updated: UpdatedEntry[];
  newProducts: NewEntry[];
  missing: MissingEntry[];
}

// export field -> product column. Optional ones are feature-detected.
const ALWAYS = [
  { ex: "name_en", col: "name_en", type: "str" },
  { ex: "name_ar", col: "name_ar", type: "str" },
  { ex: "description_en", col: "description_en", type: "str" },
  { ex: "description_ar", col: "description_ar", type: "str" },
  { ex: "price", col: "price", type: "num" },
  { ex: "discount", col: "discount_price", type: "num" },
] as const;
const OPTIONAL = [
  { ex: "approval", col: "approval", type: "str" },
  { ex: "is_featured", col: "is_featured", type: "bool" },
  { ex: "is_promoted", col: "is_promoted", type: "bool" },
  { ex: "has_buy1get1", col: "has_buy1get1", type: "bool" },
] as const;

const s = (v: unknown) => String(v ?? "").trim();
const numEq = (a: unknown, b: unknown) => {
  const x = s(a), y = s(b);
  if (x === "" && y === "") return true;
  const nx = Number(x), ny = Number(y);
  if (isNaN(nx) || isNaN(ny)) return x === y;
  return nx === ny;
};
const boolNorm = (v: unknown) => {
  const t = s(v).toLowerCase();
  if (["true", "1", "yes", "y"].includes(t)) return "true";
  if (["false", "0", "no", "n", ""].includes(t)) return "false";
  return t;
};

export async function computeSnoonuDiff(rows: SnoonuExportRow[]): Promise<SnoonuDiff> {
  const empty: SnoonuDiff = {
    ok: false, existingOptionalCols: [], missingOptionalCols: [],
    counts: { exportRows: 0, matched: 0, updated: 0, newCount: 0, missing: 0, unchanged: 0 },
    updated: [], newProducts: [], missing: [],
  };
  if (!rows?.length) return { ...empty, error: "No rows parsed from the export." };

  const supabase = createClient();

  // Feature-detect optional columns.
  const existingOptional: typeof OPTIONAL[number][] = [];
  const missingOptionalCols: string[] = [];
  for (const f of OPTIONAL) {
    const { error } = await supabase.from("products").select(f.col).limit(1);
    if (error) missingOptionalCols.push(f.col);
    else existingOptional.push(f);
  }
  const fields = [...ALWAYS, ...existingOptional];

  // Load all products (snoonu_id keyed) with the columns we compare.
  const cols = ["id", "snoonu_id", "sku", "name_en", ...new Set(fields.map((f) => f.col))].join(", ");
  const products: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("products").select(cols).range(from, from + 999);
    if (error) return { ...empty, error: `Read products failed: ${error.message}` };
    products.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  const bySnoonu = new Map<string, any>();
  for (const p of products) if (p.snoonu_id) bySnoonu.set(String(p.snoonu_id), p);

  const updated: UpdatedEntry[] = [];
  const newProducts: NewEntry[] = [];
  const seenIds = new Set<string>();
  let unchanged = 0;

  for (const r of rows) {
    const id = s(r.id);
    if (!id) continue;
    seenIds.add(id);
    const p = bySnoonu.get(id);
    if (!p) { newProducts.push({ id, name_en: s(r.name_en) }); continue; }

    const changes: FieldChange[] = [];
    for (const f of fields) {
      const exVal = (r as any)[f.ex];
      if (exVal === undefined) continue; // column not present in export
      const dbVal = p[f.col];
      let differs = false;
      if (f.type === "num") differs = !numEq(dbVal, exVal);
      else if (f.type === "bool") differs = boolNorm(dbVal) !== boolNorm(exVal);
      else differs = s(dbVal) !== s(exVal);
      if (differs) changes.push({ field: f.col, old: s(dbVal) || "—", new: s(exVal) || "—" });
    }
    if (changes.length) updated.push({ snoonu_id: id, product_id: p.id, name_en: p.name_en ?? s(r.name_en), changes });
    else unchanged++;
  }

  const missing: MissingEntry[] = products
    .filter((p) => p.snoonu_id && !seenIds.has(String(p.snoonu_id)))
    .map((p) => ({ snoonu_id: String(p.snoonu_id), product_id: p.id, sku: p.sku ?? null, name_en: p.name_en ?? null }));

  return {
    ok: true,
    existingOptionalCols: existingOptional.map((f) => f.col),
    missingOptionalCols,
    counts: {
      exportRows: rows.length,
      matched: rows.length - newProducts.length,
      updated: updated.length,
      newCount: newProducts.length,
      missing: missing.length,
      unchanged,
    },
    updated,
    newProducts,
    missing,
  };
}
