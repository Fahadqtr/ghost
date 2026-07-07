"use server";

import { createClient } from "@/lib/supabase/server";
import { isSignedIn } from "@/lib/auth/requireUser";
import { revalidatePath } from "next/cache";
import { shopifyConfigured, fetchAllShopifyProducts, updateVariantPrice, updateShopifyProductContent, fetchPrimaryLocationId, createShopifyProduct } from "@/lib/shopify/admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { runShopifyInventorySync, type InventorySyncResult } from "@/lib/shopify/inventory-sync";
import { diffShopify, targetShopifyPrice, indexShopify, normTitle, htmlFromPlain, mapShopifyToCatalogRow, type ShopifyDiff, type OurProductRow } from "@/lib/shopify-diff";

export type { ShopifyDiff } from "@/lib/shopify-diff";

const EMPTY: ShopifyDiff = {
  ok: false,
  counts: { ours: 0, shopify: 0, matched: 0, updated: 0, unchanged: 0, onlyShopify: 0, onlyOurs: 0 },
  updated: [], onlyShopify: [], onlyOurs: [],
};

async function readAllProducts(client: any): Promise<OurProductRow[]> {
  const out: OurProductRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await client
      .from("products")
      .select("id, sku, name_en, name_ar, price, discount_price, approval")
      .range(from, from + 999);
    if (error) throw new Error(`Read products failed: ${error.message}`);
    out.push(...((data ?? []) as OurProductRow[]));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

/** READ-ONLY: pull the live Shopify catalog and diff it against ours. */
export async function computeShopifyDiff(): Promise<ShopifyDiff> {
  if (!(await isSignedIn())) return { ...EMPTY, error: "Not signed in." };
  if (!shopifyConfigured()) {
    return { ...EMPTY, error: "شوبي فاي غير مربوط — أضف SHOPIFY_STORE_DOMAIN و SHOPIFY_CLIENT_ID و SHOPIFY_CLIENT_SECRET في Vercel، ثم افتح /api/shopify/install لإتمام الربط." };
  }
  try {
    const sb = await createClient();
    const [ours, remote] = await Promise.all([readAllProducts(sb), fetchAllShopifyProducts()]);
    if (remote.error) return { ...EMPTY, error: remote.error };
    return diffShopify(ours, remote.products ?? []);
  } catch (e) {
    return { ...EMPTY, error: e instanceof Error ? e.message : "Diff failed." };
  }
}

export interface ShopifyApplyResult {
  ok: boolean;
  error?: string;
  updated: number;
  failed: { name: string; error: string }[];
}

/**
 * Push OUR prices to the matched Shopify variants (price + compare-at only —
 * the safest, most valuable write; titles/status stay read-only for now).
 */
export async function applyShopifyPrices(productIds: string[]): Promise<ShopifyApplyResult> {
  if (!(await isSignedIn())) return { ok: false, error: "Not signed in.", updated: 0, failed: [] };
  if (!shopifyConfigured()) return { ok: false, error: "شوبي فاي غير مربوط.", updated: 0, failed: [] };
  const ids = [...new Set(productIds)].filter(Boolean).slice(0, 200);
  if (!ids.length) return { ok: false, error: "ما في منتجات محددة.", updated: 0, failed: [] };

  try {
    const sb = await createClient();
    const { data, error } = await sb
      .from("products")
      .select("id, sku, name_en, name_ar, price, discount_price, approval")
      .in("id", ids);
    if (error) return { ok: false, error: error.message, updated: 0, failed: [] };

    const remote = await fetchAllShopifyProducts();
    if (remote.error) return { ok: false, error: remote.error, updated: 0, failed: [] };
    const diff = diffShopify((data ?? []) as OurProductRow[], remote.products ?? []);
    const byId = new Map(((data ?? []) as OurProductRow[]).map((p) => [p.id, p]));

    let updated = 0;
    const failed: { name: string; error: string }[] = [];
    for (const m of diff.updated) {
      const o = byId.get(m.product_id);
      if (!o) continue;
      const priceChange = m.changes.some((c) => c.field === "price" || c.field === "compare_at");
      if (!priceChange) continue;
      const want = targetShopifyPrice(o);
      const r = await updateVariantPrice(m.shopify_id, m.variant_id, want.price, want.compareAtPrice);
      if (r.ok) updated++;
      else failed.push({ name: m.name_en, error: r.error ?? "فشل التحديث" });
    }
    revalidatePath("/import-export/shopify-sync");
    return { ok: true, updated, failed };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Apply failed.", updated: 0, failed: [] };
  }
}

/**
 * Push OUR titles and statuses to the matched Shopify products (the catalog
 * wins: name_en becomes the store title, Approved -> ACTIVE else DRAFT).
 */
export async function applyShopifyContent(productIds: string[]): Promise<ShopifyApplyResult> {
  if (!(await isSignedIn())) return { ok: false, error: "Not signed in.", updated: 0, failed: [] };
  if (!shopifyConfigured()) return { ok: false, error: "شوبي فاي غير مربوط.", updated: 0, failed: [] };
  const ids = [...new Set(productIds)].filter(Boolean).slice(0, 200);
  if (!ids.length) return { ok: false, error: "ما في منتجات محددة.", updated: 0, failed: [] };

  try {
    const sb = await createClient();
    const { data, error } = await sb
      .from("products")
      .select("id, sku, name_en, name_ar, price, discount_price, approval")
      .in("id", ids);
    if (error) return { ok: false, error: error.message, updated: 0, failed: [] };

    const remote = await fetchAllShopifyProducts();
    if (remote.error) return { ok: false, error: remote.error, updated: 0, failed: [] };
    const diff = diffShopify((data ?? []) as OurProductRow[], remote.products ?? []);

    let updated = 0;
    const failed: { name: string; error: string }[] = [];
    for (const m of diff.updated) {
      const title = m.changes.find((c) => c.field === "title")?.new;
      const status = m.changes.find((c) => c.field === "status")?.new;
      if (!title && !status) continue;
      const r = await updateShopifyProductContent(m.shopify_id, {
        ...(title ? { title } : {}),
        ...(status === "ACTIVE" || status === "DRAFT" ? { status } : {}),
      });
      if (r.ok) updated++;
      else failed.push({ name: m.name_en, error: r.error ?? "فشل التحديث" });
    }
    revalidatePath("/import-export/shopify-sync");
    return { ok: true, updated, failed };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Apply failed.", updated: 0, failed: [] };
  }
}

/** Push OUR stock quantities to Shopify (same engine as the nightly cron). */
export async function syncShopifyInventory(): Promise<InventorySyncResult> {
  const empty = { matched: 0, unmatched: 0, drift: 0, updated: 0, examples: [] as string[] };
  if (!(await isSignedIn())) return { ok: false, error: "Not signed in.", ...empty };
  let sb;
  try { sb = createAdminClient(); }
  catch { return { ok: false, error: "الخادم غير مهيأ (SUPABASE_SERVICE_ROLE_KEY).", ...empty }; }
  const res = await runShopifyInventorySync(sb);
  revalidatePath("/import-export/shopify-sync");
  return res;
}

export interface BulkMoveResult {
  ok: boolean;
  error?: string;
  created: number;
  skipped: number;
  failed: { name: string; error: string }[];
}

const MOVE_EMPTY = { created: 0, skipped: 0, failed: [] as { name: string; error: string }[] };

/**
 * Create the given catalog products ON SHOPIFY (≤8 per call — the client
 * chunks). Re-fetches the store first so already-matched rows are skipped:
 * double-taps can never create duplicates.
 */
export async function pushProductsToShopify(productIds: string[]): Promise<BulkMoveResult> {
  if (!(await isSignedIn())) return { ok: false, error: "Not signed in.", ...MOVE_EMPTY };
  if (!shopifyConfigured()) return { ok: false, error: "شوبي فاي غير مربوط.", ...MOVE_EMPTY };
  const ids = [...new Set(productIds)].filter(Boolean).slice(0, 8);
  if (!ids.length) return { ok: false, error: "ما في منتجات محددة.", ...MOVE_EMPTY };

  try {
    const sb = createAdminClient();
    const { data, error } = await sb
      .from("products")
      .select("id, sku, name_en, name_ar, description_en, description_ar, price, discount_price, approval, image_url")
      .in("id", ids);
    if (error) return { ok: false, error: error.message, ...MOVE_EMPTY };

    const remote = await fetchAllShopifyProducts();
    if (remote.error) return { ok: false, error: remote.error, ...MOVE_EMPTY };
    const { match } = indexShopify(remote.products ?? []);
    const loc = await fetchPrimaryLocationId();

    let created = 0, skipped = 0;
    const failed: { name: string; error: string }[] = [];
    for (const p of (data ?? []) as (OurProductRow & { description_en: string | null; description_ar: string | null; image_url: string | null })[]) {
      const name = String(p.name_en || p.name_ar || "").trim();
      if (!name) { skipped++; continue; }
      if (match(p.sku, p.name_en)) { skipped++; continue; } // already on the store

      // Opening stock for the new product.
      let stock = 0;
      try {
        const { data: inv } = await sb.from("inventory").select("stock_quantity").eq("product_id", p.id);
        stock = ((inv ?? []) as { stock_quantity: number | null }[]).reduce((s, r) => s + (Number(r.stock_quantity) || 0), 0);
      } catch { /* stock stays 0 */ }

      const want = targetShopifyPrice(p);
      const res = await createShopifyProduct({
        title: name,
        descriptionHtml: htmlFromPlain(p.description_en || p.description_ar || ""),
        status: String(p.approval ?? "") === "Approved" ? "ACTIVE" : "DRAFT",
        price: want.price || "0.00",
        compareAtPrice: want.compareAtPrice,
        sku: p.sku,
        quantity: stock,
        locationId: loc.locationId ?? null,
        imageUrl: p.image_url,
      });
      if (res.ok) created++;
      else failed.push({ name, error: res.error ?? "فشل الإنشاء" });
    }
    revalidatePath("/import-export/shopify-sync");
    return { ok: true, created, skipped, failed };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Push failed.", ...MOVE_EMPTY };
  }
}

/**
 * Import the given Shopify products INTO the catalog (≤40 per call), seeding
 * an inventory row from the store's current quantity. Duplicates (by SKU or
 * normalized title against existing products) are skipped.
 */
export async function importShopifyProducts(shopifyIds: string[]): Promise<BulkMoveResult> {
  if (!(await isSignedIn())) return { ok: false, error: "Not signed in.", ...MOVE_EMPTY };
  if (!shopifyConfigured()) return { ok: false, error: "شوبي فاي غير مربوط.", ...MOVE_EMPTY };
  const ids = new Set([...new Set(shopifyIds)].filter(Boolean).slice(0, 40));
  if (!ids.size) return { ok: false, error: "ما في منتجات محددة.", ...MOVE_EMPTY };

  try {
    const sb = createAdminClient();
    const remote = await fetchAllShopifyProducts();
    if (remote.error) return { ok: false, error: remote.error, ...MOVE_EMPTY };
    const wanted = (remote.products ?? []).filter((p) => ids.has(p.id));

    // Existing catalog keys for the duplicate guard.
    const existingSkus = new Set<string>();
    const existingNames = new Set<string>();
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from("products").select("sku, name_en").range(from, from + 999);
      if (error) return { ok: false, error: error.message, ...MOVE_EMPTY };
      for (const r of (data ?? []) as { sku: string | null; name_en: string | null }[]) {
        const k = String(r.sku ?? "").trim().toLowerCase();
        if (k) existingSkus.add(k);
        const t = normTitle(r.name_en);
        if (t) existingNames.add(t);
      }
      if ((data ?? []).length < 1000) break;
    }

    let created = 0, skipped = 0;
    const failed: { name: string; error: string }[] = [];
    for (const p of wanted) {
      const row = mapShopifyToCatalogRow(p);
      const skuKey = String(row.sku ?? "").trim().toLowerCase();
      if ((skuKey && existingSkus.has(skuKey)) || existingNames.has(normTitle(row.name_en))) { skipped++; continue; }

      const { data: ins, error: insErr } = await sb.from("products").insert(row).select("id").single();
      if (insErr || !ins?.id) { failed.push({ name: row.name_en, error: insErr?.message ?? "insert failed" }); continue; }
      created++;
      existingNames.add(normTitle(row.name_en));
      if (skuKey) existingSkus.add(skuKey);

      // Seed the stock from the store's current quantity (best-effort).
      const qty = Math.max(0, Number(p.variants[0]?.inventoryQuantity ?? 0) || 0);
      try { await sb.from("inventory").insert({ product_id: ins.id, stock_quantity: qty }); } catch { /* optional */ }
    }
    revalidatePath("/import-export/shopify-sync");
    return { ok: true, created, skipped, failed };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Import failed.", ...MOVE_EMPTY };
  }
}
