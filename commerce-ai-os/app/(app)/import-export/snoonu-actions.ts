"use server";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { revalidatePath } from "next/cache";

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

type Field = { ex: string; col: string; type: string };

// Coerce a non-empty export string to the proper write value for its column.
function writeVal(type: string, exStr: string): unknown {
  if (type === "num") { const n = Number(exStr); return isNaN(n) ? null : n; }
  if (type === "bool") { const b = boolNorm(exStr); return b === "true" ? true : b === "false" ? false : null; }
  return exStr;
}

// Changes for one product vs one export row. EMPTY export cells are SKIPPED —
// a blank in the Snoonu export never blanks our data (and keeps diff==apply).
function computeChanges(p: any, r: any, fields: Field[]) {
  const changes: { field: string; old: string; new: string; writeValue: unknown }[] = [];
  for (const f of fields) {
    const exRaw = r[f.ex];
    if (exRaw === undefined) continue;        // column not in export
    const exStr = s(exRaw);
    if (exStr === "") continue;               // empty cell -> no update
    const dbVal = p[f.col];
    let differs: boolean;
    if (f.type === "num") differs = !numEq(dbVal, exStr);
    else if (f.type === "bool") differs = boolNorm(dbVal) !== boolNorm(exStr);
    else differs = s(dbVal) !== exStr;
    if (differs) changes.push({ field: f.col, old: s(dbVal) || "—", new: exStr, writeValue: writeVal(f.type, exStr) });
  }
  return changes;
}

// Detect which optional columns exist; returns the active field list + missing.
async function detectFields(client: any): Promise<{ fields: Field[]; existing: string[]; missing: string[] }> {
  const existingOptional: Field[] = [];
  const missing: string[] = [];
  for (const f of OPTIONAL) {
    const { error } = await client.from("products").select(f.col).limit(1);
    if (error) missing.push(f.col); else existingOptional.push(f);
  }
  return { fields: [...ALWAYS, ...existingOptional], existing: existingOptional.map((f) => f.col), missing };
}

export async function computeSnoonuDiff(rows: SnoonuExportRow[]): Promise<SnoonuDiff> {
  const empty: SnoonuDiff = {
    ok: false, existingOptionalCols: [], missingOptionalCols: [],
    counts: { exportRows: 0, matched: 0, updated: 0, newCount: 0, missing: 0, unchanged: 0 },
    updated: [], newProducts: [], missing: [],
  };
  if (!rows?.length) return { ...empty, error: "No rows parsed from the export." };

  const supabase = createClient();

  // Feature-detect optional columns.
  const { fields, existing: existingOptionalCols, missing: missingOptionalCols } = await detectFields(supabase);

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

    const ch = computeChanges(p, r, fields);
    if (ch.length) {
      updated.push({
        snoonu_id: id, product_id: p.id, name_en: p.name_en ?? s(r.name_en),
        changes: ch.map((c) => ({ field: c.field, old: c.old, new: c.new })),
      });
    } else unchanged++;
  }

  const missing: MissingEntry[] = products
    .filter((p) => p.snoonu_id && !seenIds.has(String(p.snoonu_id)))
    .map((p) => ({ snoonu_id: String(p.snoonu_id), product_id: p.id, sku: p.sku ?? null, name_en: p.name_en ?? null }));

  return {
    ok: true,
    existingOptionalCols,
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

export interface ApplyResult {
  ok: boolean;
  error?: string;
  productsUpdated: number;
  fieldWrites: number;
  matched: number;
  unchanged: number;
  failed: number;
  columnsWritten: string[];
}

// Milestone 2: write the diff. Matched rows only (by snoonu_id). NEW and MISSING
// are never created/deleted here. Re-diffs server-side (never trusts the client
// to say what changed) and uses the service-role key.
export async function applySnoonuUpdates(rows: SnoonuExportRow[]): Promise<ApplyResult> {
  const base: ApplyResult = { ok: false, productsUpdated: 0, fieldWrites: 0, matched: 0, unchanged: 0, failed: 0, columnsWritten: [] };
  if (!rows?.length) return { ...base, error: "No rows to apply." };

  // Must be signed in.
  const { data: { user } } = await createClient().auth.getUser();
  if (!user) return { ...base, error: "Not signed in." };

  let admin: ReturnType<typeof createAdminClient>;
  try { admin = createAdminClient(); }
  catch (e) { return { ...base, error: e instanceof Error ? e.message : "Service role unavailable." }; }

  const { fields } = await detectFields(admin);

  // Load products keyed by snoonu_id.
  const cols = ["id", "snoonu_id", "name_en", ...new Set(fields.map((f) => f.col))].join(", ");
  const products: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin.from("products").select(cols).range(from, from + 999);
    if (error) return { ...base, error: `Read products failed: ${error.message}` };
    products.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  const bySnoonu = new Map<string, any>();
  for (const p of products) if (p.snoonu_id) bySnoonu.set(String(p.snoonu_id), p);

  // Build per-product updates from re-computed changes.
  const updates: { id: string; patch: Record<string, unknown> }[] = [];
  const colsWritten = new Set<string>();
  let matched = 0, unchanged = 0, fieldWrites = 0;
  for (const r of rows) {
    const id = s(r.id);
    const p = id && bySnoonu.get(id);
    if (!p) continue;
    matched++;
    const ch = computeChanges(p, r, fields);
    if (!ch.length) { unchanged++; continue; }
    const patch: Record<string, unknown> = {};
    for (const c of ch) { patch[c.field] = c.writeValue; colsWritten.add(c.field); fieldWrites++; }
    updates.push({ id: p.id, patch });
  }

  // Apply with limited concurrency.
  let productsUpdated = 0, failed = 0, idx = 0;
  async function worker() {
    while (idx < updates.length) {
      const u = updates[idx++];
      const { error } = await admin.from("products").update(u.patch).eq("id", u.id);
      if (error) failed++; else productsUpdated++;
    }
  }
  await Promise.all(Array.from({ length: 12 }, worker));

  revalidatePath("/products");
  revalidatePath("/import-export/snoonu-sync");
  return {
    ok: true, productsUpdated, fieldWrites, matched, unchanged, failed,
    columnsWritten: [...colsWritten],
  };
}
