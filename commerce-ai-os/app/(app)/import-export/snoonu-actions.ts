"use server";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { revalidatePath } from "next/cache";
import {
  ALWAYS, OPTIONAL, readColumns, computeChanges, diffSnoonu, s,
  type Field, type SnoonuExportRow, type SnoonuDiff,
} from "@/lib/snoonu-diff";
import { clean } from "@/lib/malak/talabat-export.mjs";

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
    counts: { exportRows: 0, matched: 0, updated: 0, newCount: 0, missing: 0, unchanged: 0, rejected: 0, unavailable: 0 },
    fieldCounts: {}, changedColsPerProduct: [],
    updated: [], newProducts: [], missing: [], rejected: [], unavailable: [],
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

    // Matched products that are REJECTED in our catalog (present in the upload).
    const exportIds = new Set(rows.map((r) => s(r.id)).filter(Boolean));
    const rejected = products
      .filter((p: any) => p.snoonu_id && exportIds.has(String(p.snoonu_id)) && String(p.approval) === "Rejected")
      .map((p: any) => ({ snoonu_id: String(p.snoonu_id), product_id: p.id, sku: p.sku ?? null, name_en: p.name_en ?? null }));

    // Matched products marked UNAVAILABLE on Snoonu (Availability=False in the file).
    const unavailIds = new Set(
      rows.filter((r) => String(r.availability ?? "").trim().toLowerCase() === "false").map((r) => s(r.id)).filter(Boolean)
    );
    const unavailable = products
      .filter((p: any) => p.snoonu_id && unavailIds.has(String(p.snoonu_id)))
      .map((p: any) => ({ snoonu_id: String(p.snoonu_id), product_id: p.id, sku: p.sku ?? null, name_en: p.name_en ?? null }));

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
        rejected: rejected.length,
        unavailable: unavailable.length,
      },
      fieldCounts,
      changedColsPerProduct,
      // Cap the lists sent back to the client (counts above stay exact). With
      // the new columns, nearly every row can be "UPDATED" — returning all of
      // them (with full descriptions) would be a multi-MB RSC payload.
      updated: d.updated.slice(0, 200),
      newProducts: d.newProducts.slice(0, 200),
      missing: d.missing.slice(0, 200),
      rejected: rejected.slice(0, 200),
      unavailable: unavailable.slice(0, 300),
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

export interface AddNewResult {
  ok: boolean;
  error?: string;
  added: number;
  skipped: number; // already existed (matched a snoonu_id) — never duplicated
  failed: number;
}

// Create the user-approved NEW products (those in the export with a SPI that is
// not yet a products.snoonu_id). Re-checks server-side so it never duplicates an
// existing product. Writes via the service-role key. Each product gets a
// placeholder SKU (SN-<spi>), category "Uncategorized", emoji-cleaned name/desc,
// price, and a seeded inventory row. Other fields are left blank for the user to
// fill (SKU/category/image) — so Malak shows them as uncategorized new items.
export async function addSnoonuNewProducts(
  rows: SnoonuExportRow[],
  selectedIds: string[]
): Promise<AddNewResult> {
  const base: AddNewResult = { ok: false, added: 0, skipped: 0, failed: 0 };
  if (!rows?.length) return { ...base, error: "No rows uploaded." };
  const want = new Set((selectedIds ?? []).map((x) => String(x).trim()).filter(Boolean));
  if (want.size === 0) return { ...base, error: "No products selected to add." };

  const { data: { user } } = await createClient().auth.getUser();
  if (!user) return { ...base, error: "Not signed in." };

  let admin: ReturnType<typeof createAdminClient>;
  try { admin = createAdminClient(); }
  catch (e) { return { ...base, error: e instanceof Error ? e.message : "Service role unavailable." }; }

  try {
    // Existing snoonu_ids (avoid duplicates) + max mk#### number + barcodes
    // (so generated SKUs/barcodes never clash with the catalog).
    const existing = new Set<string>();
    let maxMk = 0;
    const usedBarcodes = new Set<string>();
    for (let from = 0; ; from += 1000) {
      const { data, error } = await admin.from("products").select("snoonu_id, sku, barcode").range(from, from + 999);
      if (error) return { ...base, error: `Read products failed: ${error.message}` };
      for (const p of data ?? []) {
        if (p.snoonu_id) existing.add(String(p.snoonu_id).trim());
        const m = /^mk(\d+)$/i.exec(String(p.sku ?? "").trim());
        if (m) maxMk = Math.max(maxMk, parseInt(m[1], 10));
        const bc = String(p.barcode ?? "").trim();
        if (bc) usedBarcodes.add(bc);
      }
      if ((data ?? []).length < 1000) break;
    }

    // Next SKU in the catalog's mk#### scheme.
    const nextSku = () => `mk${++maxMk}`;
    // Unique 13-digit EAN-13 (internal "29" prefix + counter + check digit),
    // guaranteed not to collide with any existing or in-batch barcode.
    const ean13Check = (d12: string) => {
      let sum = 0;
      for (let i = 0; i < 12; i++) sum += (+d12[i]) * (i % 2 === 0 ? 1 : 3);
      return String((10 - (sum % 10)) % 10);
    };
    let bcSeq = 1;
    const nextBarcode = () => {
      for (;;) {
        const base = "29" + String(bcSeq++).padStart(10, "0");
        const bc = base + ean13Check(base);
        if (!usedBarcodes.has(bc)) { usedBarcodes.add(bc); return bc; }
      }
    };

    const num = (v: unknown) => { const t = s(v); if (t === "") return null; const n = Number(t); return isNaN(n) ? null : n; };
    const seen = new Set<string>();
    const toInsert: Record<string, unknown>[] = [];
    let skipped = 0;
    for (const r of rows) {
      const id = s(r.id);
      if (!id || !want.has(id) || seen.has(id)) continue;
      seen.add(id);
      if (existing.has(id)) { skipped++; continue; } // already in catalog — never duplicate
      toInsert.push({
        sku: nextSku(),               // mk#### like the rest of the catalog
        barcode: nextBarcode(),       // auto, unique, no clash with old barcodes
        snoonu_id: id,
        name_en: clean(r.name_en),
        name_ar: clean(r.name_ar),
        description_en: clean(r.description_en),
        description_ar: clean(r.description_ar),
        price: num(r.price),
        main_category: "Uncategorized",
        notes: "Imported from Snoonu sync — set category / image.",
      });
    }

    if (toInsert.length === 0) return { ok: true, added: 0, skipped, failed: 0 };

    // Insert in chunks; collect ids to seed inventory.
    const chunk = (a: any[], n: number) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
    let added = 0, failed = 0;
    const newIds: string[] = [];
    for (const part of chunk(toInsert, 200)) {
      const { data, error } = await admin.from("products").insert(part).select("id");
      if (error) { failed += part.length; continue; }
      added += data?.length ?? 0;
      for (const p of data ?? []) newIds.push(p.id);
    }

    // Seed inventory rows so they show on the Inventory page (stock 0 to start).
    if (newIds.length) {
      const invRows = newIds.map((product_id) => ({ product_id, stock_quantity: 0, low_stock_threshold: 5, sold_quantity: 0 }));
      for (const part of chunk(invRows, 200)) await admin.from("inventory").insert(part);
    }

    revalidatePath("/products");
    revalidatePath("/import-export/snoonu-sync");
    return { ok: true, added, skipped, failed };
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : "Unexpected error while adding products." };
  }
}
