"use server";

import { createClient } from "@/lib/supabase/server";
import { isSignedIn } from "@/lib/auth/requireUser";
import { requireMalakWriter } from "@/lib/malak/authz";
import { revalidatePath } from "next/cache";
import { shopifyConfigured, fetchAllShopifyProducts, updateVariantPrice, updateShopifyProductContent, addProductImage } from "@/lib/shopify/admin";
import { safeImageUrlOrNull, safeFetchImage } from "@/lib/net/safeImage";
import { createAdminClient } from "@/lib/supabase/admin";
import { runShopifyInventorySync, type InventorySyncResult } from "@/lib/shopify/inventory-sync";
import { logCatalogTask } from "@/lib/tasks/catalog-log";
import { diffShopify, targetShopifyPrice, normTitle, mapShopifyToCatalogRow, type ShopifyDiff, type OurProductRow } from "@/lib/shopify-diff";
import { isOperationalShopifyProduct } from "@/lib/shopify/operational-eligibility";
import { createProductCore } from "@/lib/products/product-create";
import { makeInventoryInitializer } from "@/lib/products/inventory-initializer";

export type { ShopifyDiff } from "@/lib/shopify-diff";

const EMPTY: ShopifyDiff = {
  ok: false,
  counts: { ours: 0, shopify: 0, matched: 0, updated: 0, unchanged: 0, onlyShopify: 0, onlyOurs: 0, duplicates: 0 },
  updated: [], onlyShopify: [], onlyOurs: [], duplicates: [],
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
  { const writer = await requireMalakWriter(); if (!writer.ok) return { ok: false, error: writer.error, updated: 0, failed: [] }; }
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
  { const writer = await requireMalakWriter(); if (!writer.ok) return { ok: false, error: writer.error, updated: 0, failed: [] }; }
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
  { const writer = await requireMalakWriter(); if (!writer.ok) return { ok: false, error: writer.error, ...empty }; }
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
 * RETIRED (INT.2G). This was the legacy operator path that CREATED products on
 * Shopify — a SECOND publish boundary that bypassed the certified pipeline: it
 * matched by fuzzy SKU/title (never ECL identity), computed no row fingerprint,
 * skipped staleness detection, and wrote no export_runs audit row. It duplicated
 * the certified Shopify publisher and could create divergent/duplicate listings.
 *
 * INT.2F removed its UI trigger from the Shopify Sync tool; INT.2G finishes the
 * retirement at the code level so NO path (UI, action, or the dormant CH.4
 * adapter) can create products through it. The single Shopify publish boundary is
 * now exactly one flow:
 *   Export Center → Shopify Preview → Shopify Publish
 *   (/v2/export/shopify:malikas → /api/export/shopify/publish →
 *    lib/export/shopify/publish.server.ts — ECL identity, row fingerprint,
 *    staleness guard, export_runs audit).
 *
 * Kept as a writer-gated no-op (not deleted) so the authorization-boundary guards
 * that pin this action stay green and no importer can be silently broken. It
 * performs no side effect and never calls createShopifyProduct.
 */
export async function pushProductsToShopify(_productIds: string[]): Promise<BulkMoveResult> {
  { const writer = await requireMalakWriter(); if (!writer.ok) return { ok: false, error: writer.error, ...MOVE_EMPTY }; }
  return {
    ok: false,
    error: "تم إيقاف هذا المسار (نشر قديم). انشر المنتجات عبر مركز التصدير — شوبي فاي: /v2/export/shopify:malikas (نشر آمن الهوية عبر ECL وخاضع للتدقيق).",
    ...MOVE_EMPTY,
  };
}

/**
 * Import the given Shopify products INTO the catalog (≤40 per call), seeding
 * an inventory row from the store's current quantity. Duplicates (by SKU or
 * normalized title against existing products) are skipped.
 */
export async function importShopifyProducts(shopifyIds: string[]): Promise<BulkMoveResult> {
  { const writer = await requireMalakWriter(); if (!writer.ok) return { ok: false, error: writer.error, ...MOVE_EMPTY }; }
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

      // Product + inventory now go through the shared create core (P6). The
      // store's current quantity seeds inventory via `seedQuantity` WITHOUT being
      // added to the product row — mapShopifyToCatalogRow's output is inserted
      // unchanged. The core COMPENSATES (deletes the product) if the inventory
      // seed fails, so a failed seed can no longer leave an orphan product.
      const qty = Math.max(0, Number(p.variants[0]?.inventoryQuantity ?? 0) || 0);
      const core = await createProductCore(sb, row as unknown as Record<string, unknown>, [], makeInventoryInitializer(sb), { seedQuantity: qty });
      if (!core.ok) {
        // Fixed/safe text — never a raw DB error. Only advance the counters +
        // dedup sets on a fully-committed row, so a rolled-back product is not
        // counted as created and doesn't poison the in-loop dedup guard.
        failed.push({ name: row.name_en, error: "تعذّر إنشاء المنتج في الكتالوج." });
        continue;
      }
      created++;
      existingNames.add(normTitle(row.name_en));
      if (skuKey) existingSkus.add(skuKey);
    }
    if (created > 0) {
      await logCatalogTask({ action: "bulk", note: `انستورد ${created} منتج من شوبي فاي للكتالوج — راجعها وحدّث المنصات اليدوية بالجديد منها.` });
    }
    revalidatePath("/import-export/shopify-sync");
    return { ok: true, created, skipped, failed };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Import failed.", ...MOVE_EMPTY };
  }
}

// ---- Missing store images --------------------------------------------------------
// Store products without a picture + a matched catalog product WITH one.
// Every candidate image is probed before pushing, so a broken/truncated file
// (the reason the store copy has no image in the first place) never ships.

export interface MissingImagePair {
  shopify_id: string;
  title: string;
  sku: string | null;
  image_url: string;
}

export async function listShopifyMissingImages(): Promise<{
  ok: boolean; error?: string;
  pairs: MissingImagePair[];   // fixable: we have an image for them
  storeMissing: number;        // store products without any image
}> {
  if (!(await isSignedIn())) return { ok: false, error: "Not signed in.", pairs: [], storeMissing: 0 };
  if (!shopifyConfigured()) return { ok: false, error: "شوبي فاي غير مربوط.", pairs: [], storeMissing: 0 };

  try {
    const sb = await createClient();
    const ours: { id: string; sku: string | null; name_en: string | null; image_url: string | null }[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from("products").select("id, sku, name_en, image_url").range(from, from + 999);
      if (error) return { ok: false, error: error.message, pairs: [], storeMissing: 0 };
      ours.push(...((data ?? []) as typeof ours));
      if ((data ?? []).length < 1000) break;
    }
    const bySku = new Map<string, string>();   // sku -> image_url
    const byTitle = new Map<string, string>(); // normTitle -> image_url
    for (const o of ours) {
      const img = String(o.image_url ?? "").trim();
      if (!img) continue;
      const k = String(o.sku ?? "").trim().toLowerCase();
      if (k && !bySku.has(k)) bySku.set(k, img);
      const t = normTitle(o.name_en);
      if (t && !byTitle.has(t)) byTitle.set(t, img);
    }

    const remote = await fetchAllShopifyProducts();
    if (remote.error) return { ok: false, error: remote.error, pairs: [], storeMissing: 0 };

    const pairs: MissingImagePair[] = [];
    let storeMissing = 0;
    for (const sp of remote.products ?? []) {
      // ARCHIVED products are retired identities — never offer to write media to
      // one. (`pushShopifyImages` calls addProductImage on whatever lands here.)
      if (!isOperationalShopifyProduct(sp)) continue;
      if (String(sp.imageUrl ?? "").trim()) continue;
      storeMissing++;
      const sku = String(sp.variants[0]?.sku ?? "").trim().toLowerCase();
      const img = (sku ? bySku.get(sku) : undefined) ?? byTitle.get(normTitle(sp.title));
      if (img) pairs.push({ shopify_id: sp.id, title: sp.title, sku: sp.variants[0]?.sku ?? null, image_url: img });
    }
    return { ok: true, pairs, storeMissing };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "List failed.", pairs: [], storeMissing: 0 };
  }
}

export interface PushImagesResult {
  ok: boolean;
  error?: string;
  pushed: number;
  skippedBroken: { title: string; reason: string }[]; // source image doesn't load — never pushed
  failed: { title: string; error: string }[];
}

/** Push ONE slice of the missing-image pairs (client loops; ≤10 per call). */
export async function pushShopifyImages(pairs: MissingImagePair[]): Promise<PushImagesResult> {
  const empty = { pushed: 0, skippedBroken: [], failed: [] };
  { const writer = await requireMalakWriter(); if (!writer.ok) return { ok: false, error: writer.error, ...empty }; }
  if (!shopifyConfigured()) return { ok: false, error: "شوبي فاي غير مربوط.", ...empty };
  const list = (pairs ?? []).slice(0, 10);
  if (!list.length) return { ok: false, error: "ما في صور محددة.", ...empty };

  let pushed = 0;
  const skippedBroken: { title: string; reason: string }[] = [];
  const failed: { title: string; error: string }[] = [];

  for (const pr of list) {
    const url = safeImageUrlOrNull(pr.image_url);
    if (!url) { skippedBroken.push({ title: pr.title, reason: "رابط غير صالح" }); continue; }
    // Probe before pushing: the store copy is imageless BECAUSE the source
    // was often broken — a truncated file must not ship again.
    try {
      const res = await safeFetchImage(url, { headers: { Range: "bytes=0-2047" }, cache: "no-store", signal: AbortSignal.timeout(8_000) });
      const ct = String(res.headers.get("content-type") ?? "").toLowerCase();
      if ((!res.ok && res.status !== 206) || (ct && !ct.startsWith("image/") && !ct.includes("octet-stream"))) {
        skippedBroken.push({ title: pr.title, reason: `HTTP ${res.status}${ct ? ` · ${ct.split(";")[0]}` : ""}` });
        continue;
      }
    } catch {
      skippedBroken.push({ title: pr.title, reason: "الصورة ما تتحمل (timeout)" });
      continue;
    }
    const r = await addProductImage(pr.shopify_id, pr.image_url);
    if (r.ok) pushed++;
    else failed.push({ title: pr.title, error: r.error ?? "فشل الرفع" });
  }
  revalidatePath("/import-export/shopify-sync");
  return { ok: true, pushed, skippedBroken, failed };
}
