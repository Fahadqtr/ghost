"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/auth/requireUser";

const NO_DB = "الخادم غير مهيأ (SUPABASE_SERVICE_ROLE_KEY غير مضبوط).";
const NO_TABLE = "جدول الأرشيف غير موجود — شغّل supabase/product_archive.sql أولاً.";

function adminClient(): any | null {
  try { return createAdminClient(); } catch { return null; }
}
async function adminEmail(): Promise<string | null> {
  try { const { data } = await createClient().auth.getUser(); return data.user?.email ?? null; } catch { return null; }
}

export type MatchedForArchive = {
  id: string; sku: string | null; barcode: string | null;
  name_en: string | null; name_ar: string | null; image_url: string | null;
  stock: number | null; matchedOn: string;
};

// Parse a free-text list (newlines / commas / spaces) of SKUs or barcodes and
// resolve them to real products. Returns matches + the tokens that hit nothing.
export async function matchProductsForArchive(text: string): Promise<{ matched: MatchedForArchive[]; unmatched: string[]; error?: string }> {
  const unauth = await requireUser();
  if (unauth) return { matched: [], unmatched: [], error: unauth.error };
  const admin = adminClient();
  if (!admin) return { matched: [], unmatched: [], error: NO_DB };

  const tokens = Array.from(new Set(
    String(text || "").split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean)
  )).slice(0, 500);
  if (!tokens.length) return { matched: [], unmatched: [] };

  const { data: rows, error } = await admin
    .from("products")
    .select("id, sku, barcode, name_en, name_ar, image_url, inventory(stock_quantity)")
    .or(`sku.in.(${tokens.map((t) => `"${t.replace(/"/g, "")}"`).join(",")}),barcode.in.(${tokens.map((t) => `"${t.replace(/"/g, "")}"`).join(",")})`);
  if (error) return { matched: [], unmatched: [], error: error.message };

  const matched: MatchedForArchive[] = [];
  const hitTokens = new Set<string>();
  for (const p of (rows ?? []) as any[]) {
    const onSku = p.sku && tokens.includes(String(p.sku));
    const onBc = p.barcode && tokens.includes(String(p.barcode));
    if (onSku) hitTokens.add(String(p.sku));
    if (onBc) hitTokens.add(String(p.barcode));
    matched.push({
      id: String(p.id), sku: p.sku ?? null, barcode: p.barcode ?? null,
      name_en: p.name_en ?? null, name_ar: p.name_ar ?? null, image_url: p.image_url ?? null,
      stock: p.inventory?.[0]?.stock_quantity ?? null,
      matchedOn: onSku ? String(p.sku) : onBc ? String(p.barcode) : "",
    });
  }
  const unmatched = tokens.filter((t) => !hitTokens.has(t));
  return { matched, unmatched };
}

// Snapshot each product's full bundle into product_archive, then delete it (and
// its dependent rows) from the live catalog.
export async function archiveAndDeleteProducts(ids: string[]): Promise<{ ok: true; archived: number; failed: string[] } | { error: string }> {
  const unauth = await requireUser();
  if (unauth) return unauth;
  const list = Array.from(new Set((ids ?? []).map(String))).filter(Boolean);
  if (!list.length) return { ok: true as const, archived: 0, failed: [] };
  const admin = adminClient();
  if (!admin) return { error: NO_DB };
  const by = await adminEmail();

  let archived = 0;
  const failed: string[] = [];
  for (const id of list) {
    try {
      const { data: product } = await admin.from("products").select("*").eq("id", id).single();
      if (!product) { failed.push(id); continue; }
      const [{ data: inventory }, { data: variants }, { data: channel_products }] = await Promise.all([
        admin.from("inventory").select("*").eq("product_id", id),
        admin.from("product_variants").select("*").eq("parent_product_id", id),
        admin.from("channel_products").select("*").eq("product_id", id),
      ]);

      const arch = await admin.from("product_archive").insert({
        product_id: id,
        sku: product.sku ?? null,
        barcode: product.barcode ?? null,
        name_en: product.name_en ?? null,
        name_ar: product.name_ar ?? null,
        image_url: product.image_url ?? null,
        bundle: { product, inventory: inventory ?? [], variants: variants ?? [], channel_products: channel_products ?? [] },
        archived_by: by,
      });
      if (arch.error) {
        if ((arch.error as any).code === "42P01") return { error: NO_TABLE };
        failed.push(id); continue;
      }

      // Remove dependents first, then the product.
      await admin.from("product_variants").delete().eq("parent_product_id", id);
      await admin.from("channel_products").delete().eq("product_id", id);
      await admin.from("inventory").delete().eq("product_id", id);
      const del = await admin.from("products").delete().eq("id", id);
      if (del.error) { failed.push(id); continue; }
      archived++;
    } catch {
      failed.push(id);
    }
  }
  revalidatePath("/products");
  revalidatePath("/products/archive");
  revalidatePath("/dashboard");
  return { ok: true as const, archived, failed };
}

export type ArchivedRow = {
  id: string; product_id: string | null; sku: string | null; barcode: string | null;
  name_en: string | null; name_ar: string | null; image_url: string | null;
  archived_by: string | null; archived_at: string | null;
};

export async function listArchive(limit = 100): Promise<{ rows: ArchivedRow[]; ready: boolean; error?: string }> {
  const unauth = await requireUser();
  if (unauth) return { rows: [], ready: true, error: unauth.error };
  const admin = adminClient();
  if (!admin) return { rows: [], ready: true, error: NO_DB };
  const { data, error } = await admin
    .from("product_archive")
    .select("id, product_id, sku, barcode, name_en, name_ar, image_url, archived_by, archived_at")
    .order("archived_at", { ascending: false })
    .limit(limit);
  if (error) {
    if ((error as any).code === "42P01" || /product_archive/.test(error.message)) return { rows: [], ready: false };
    return { rows: [], ready: true, error: error.message };
  }
  return { rows: (data ?? []) as ArchivedRow[], ready: true };
}

// Re-insert an archived product (and its bundle) into the live catalog, then
// drop the archive entry. Best-effort on dependents.
export async function restoreFromArchive(archiveId: string): Promise<{ ok: true } | { error: string }> {
  const unauth = await requireUser();
  if (unauth) return unauth;
  const admin = adminClient();
  if (!admin) return { error: NO_DB };
  const { data: row, error } = await admin.from("product_archive").select("bundle").eq("id", archiveId).single();
  if (error || !row) return { error: "سجل الأرشيف غير موجود." };
  const b = row.bundle || {};
  const product = b.product;
  if (!product?.id) return { error: "بيانات الأرشيف ناقصة." };

  const ins = await admin.from("products").insert(product);
  if (ins.error) {
    if ((ins.error as any).code === "23505") return { error: "الكود أو الباركود مستخدم الآن — عدّله قبل الاستعادة." };
    return { error: ins.error.message };
  }
  // Best-effort restore of dependents.
  if (Array.isArray(b.inventory) && b.inventory.length) await admin.from("inventory").insert(b.inventory);
  if (Array.isArray(b.variants) && b.variants.length) await admin.from("product_variants").insert(b.variants);
  if (Array.isArray(b.channel_products) && b.channel_products.length) await admin.from("channel_products").insert(b.channel_products);

  await admin.from("product_archive").delete().eq("id", archiveId);
  revalidatePath("/products");
  revalidatePath("/products/archive");
  return { ok: true as const };
}
