"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { CATEGORIES } from "@/lib/constants";
import { clean } from "@/lib/malak/talabat-export.mjs";

// One parsed+mapped row from the uploaded Excel, keyed by product field names.
export type ImportRow = Record<string, string>;

const str = (v: unknown) => {
  const t = String(v ?? "").trim();
  return t === "" ? null : t;
};
// Fields cleaned of emojis/decorative symbols on import (names + descriptions).
const CLEANED = new Set(["name_en", "name_ar", "description_en", "description_ar"]);
const cleanStr = (v: unknown) => {
  const t = clean(v);
  return t === "" ? null : t;
};
const num = (v: unknown) => {
  const t = String(v ?? "").trim();
  if (t === "") return null;
  const n = Number(t);
  return isNaN(n) ? null : n;
};

const PRODUCT_FIELDS = [
  "sku", "barcode", "name_en", "name_ar", "main_category", "sub_category",
  "product_type", "color", "size", "price", "discount_price", "cost",
  "stock_quantity", "stock_status", "platform_status", "image_filename",
  "image_url", "description_en", "description_ar", "keywords_en",
  "keywords_ar", "notes",
] as const;

const NUMERIC = new Set(["price", "discount_price", "cost", "stock_quantity"]);

// Commit previewed rows. Behind a confirm in the UI. Resolves brand by name,
// skips invalid categories (flags them) instead of force-fitting.
export async function importProducts(rows: ImportRow[]) {
  if (!rows || rows.length === 0) return { error: "Nothing to import." };

  const supabase = createClient();

  // Resolve brand name -> id once.
  const { data: brands } = await supabase.from("brands").select("id, name");
  const brandByName = new Map(
    (brands ?? []).map((b: any) => [String(b.name).toLowerCase(), b.id])
  );

  const toInsert: Record<string, unknown>[] = [];
  const skipped: string[] = [];

  rows.forEach((row, i) => {
    const out: Record<string, unknown> = {};
    for (const f of PRODUCT_FIELDS) {
      out[f] = NUMERIC.has(f) ? num(row[f]) : CLEANED.has(f) ? cleanStr(row[f]) : str(row[f]);
    }

    // Category must be one of the 11 — do not force-fit (plan rule).
    if (out.main_category && !CATEGORIES.includes(out.main_category as (typeof CATEGORIES)[number])) {
      skipped.push(`Row ${i + 1}: category "${out.main_category}" is not one of the 11 locked categories`);
      return;
    }

    // Resolve brand by name if a "brand" column was provided.
    const brandName = str(row.brand ?? row.brand_name);
    if (brandName) {
      const id = brandByName.get(brandName.toLowerCase());
      if (id) out.brand_id = id;
      else skipped.push(`Row ${i + 1}: brand "${brandName}" not found (left blank)`);
    }

    toInsert.push(out);
  });

  if (toInsert.length === 0) {
    return { error: "No valid rows to import.", skipped };
  }

  const { data: inserted, error } = await supabase
    .from("products")
    .insert(toInsert)
    .select("id, stock_quantity");

  if (error) return { error: error.message, skipped };

  // Seed inventory rows for the imported products.
  if (inserted && inserted.length > 0) {
    await supabase.from("inventory").insert(
      inserted.map((p: any) => ({
        product_id: p.id,
        stock_quantity: p.stock_quantity ?? 0,
        low_stock_threshold: 5,
        sold_quantity: 0,
      }))
    );
  }

  revalidatePath("/products");
  revalidatePath("/inventory");
  return { ok: true, imported: inserted?.length ?? 0, skipped };
}
