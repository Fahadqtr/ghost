"use server";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { revalidatePath } from "next/cache";
import {
  ALWAYS, OPTIONAL, readColumns, computeChanges, diffSnoonu, s,
  type Field, type SnoonuExportRow, type SnoonuDiff,
} from "@/lib/snoonu-diff";

export type { SnoonuExportRow, SnoonuDiff } from "@/lib/snoonu-diff";

// Detect which optional columns exist on `products`; returns the active field
// list + which optional columns are present/absent.
async function detectFields(client: any): Promise<{ fields: Field[]; existing: string[]; missing: string[] }> {
  const existing: Field[] = [];
  const missing: string[] = [];
  for (const f of OPTIONAL) {
    const { error } = await client.from("products").select(f.col).limit(1);
    if (error) missing.push(f.col); else existing.push(f);
  }
  return { fields: [...ALWAYS, ...existing], existing: existing.map((f) => f.col), missing };
}

async function readAllProducts(client: any, cols: string): Promise<Record<string, any>[]> {
  const out: Record<string, any>[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await client.from("products").select(cols).range(from, from + 999);
    if (error) throw new Error(`Read products failed: ${error.message}`);
    out.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

// READ-ONLY diff. Uses the anon/cookie client (no service role needed).
export async function computeSnoonuDiff(rows: SnoonuExportRow[]): Promise<SnoonuDiff> {
  const empty: SnoonuDiff = {
    ok: false, existingOptionalCols: [], missingOptionalCols: [],
    counts: { exportRows: 0, matched: 0, updated: 0, newCount: 0, missing: 0, unchanged: 0 },
    fieldCounts: {}, changedColsPerProduct: [],
    updated: [], newProducts: [], missing: [],
  };
  if (!rows?.length) return { ...empty, error: "No rows parsed from the export." };

  try {
    const supabase = createClient();
    const { fields, existing: existingOptionalCols, missing: missingOptionalCols } = await detectFields(supabase);
    const products = await readAllProducts(supabase, readColumns(fields));

    const d = diffSnoonu(products, rows, fields);

    // Per-field counts + per-product changed columns (computed over the FULL
    // updated set, before the display cap) so the UI can scope by field exactly.
    const fieldCounts: Record<string, number> = {};
    const changedColsPerProduct = d.updated.map((u) => {
      const cols = u.changes.map((c) => c.field);
      for (const col of cols) fieldCounts[col] = (fieldCounts[col] || 0) + 1;
      return cols;
    });

    return {
      ok: true,
      existingOptionalCols,
      missingOptionalCols,
      counts: {
        exportRows: rows.length,
        matched: d.matched,
        updated: d.updated.length,
        newCount: d.newProducts.length,
        missing: d.missing.length,
        unchanged: d.unchanged,
      },
      fieldCounts,
      changedColsPerProduct,
      // Cap the lists sent back to the client (counts above stay exact). With
      // the new columns, nearly every row can be "UPDATED" — returning all of
      // them (with full descriptions) would be a multi-MB RSC payload.
      updated: d.updated.slice(0, 200),
      newProducts: d.newProducts.slice(0, 200),
      missing: d.missing.slice(0, 200),
    };
  } catch (e) {
    return { ...empty, error: e instanceof Error ? e.message : "Unexpected error while computing the diff." };
  }
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

// Writes matched rows only (by snoonu_id), via the service-role key. NEW and
// MISSING are never created/deleted. Re-diffs server-side. Only the columns in
// `selectedCols` are written (and only where the normalized value differs).
export async function applySnoonuUpdates(
  rows: SnoonuExportRow[],
  selectedCols: string[]
): Promise<ApplyResult> {
  const base: ApplyResult = { ok: false, productsUpdated: 0, fieldWrites: 0, matched: 0, unchanged: 0, failed: 0, columnsWritten: [] };
  if (!rows?.length) return { ...base, error: "No rows to apply." };
  const selected = new Set((selectedCols ?? []).filter(Boolean));
  if (selected.size === 0) return { ...base, error: "No fields selected to sync." };

  const { data: { user } } = await createClient().auth.getUser();
  if (!user) return { ...base, error: "Not signed in." };

  let admin: ReturnType<typeof createAdminClient>;
  try { admin = createAdminClient(); }
  catch (e) { return { ...base, error: e instanceof Error ? e.message : "Service role unavailable." }; }

  try {
    const { fields: allFields } = await detectFields(admin);
    // Restrict to the user-selected columns.
    const fields = allFields.filter((f) => selected.has(f.col));
    if (fields.length === 0) return { ...base, error: "Selected fields are not syncable columns." };
    const products = await readAllProducts(admin, readColumns(fields));
    const bySnoonu = new Map<string, any>();
    for (const p of products) if (p.snoonu_id) bySnoonu.set(String(p.snoonu_id), p);

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
    return { ok: true, productsUpdated, fieldWrites, matched, unchanged, failed, columnsWritten: [...colsWritten] };
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : "Unexpected error while applying updates." };
  }
}
