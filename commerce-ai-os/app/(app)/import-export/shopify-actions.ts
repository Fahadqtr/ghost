"use server";

import { createClient } from "@/lib/supabase/server";
import { isSignedIn } from "@/lib/auth/requireUser";
import { revalidatePath } from "next/cache";
import { shopifyConfigured, fetchAllShopifyProducts, updateVariantPrice } from "@/lib/shopify/admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { runShopifyInventorySync, type InventorySyncResult } from "@/lib/shopify/inventory-sync";
import { diffShopify, targetShopifyPrice, type ShopifyDiff, type OurProductRow } from "@/lib/shopify-diff";

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
