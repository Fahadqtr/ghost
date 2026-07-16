"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { PLATFORMS } from "@/lib/constants";
import { pushStockToShopify } from "@/app/(app)/inventory/actions";
import {
  reconcile,
  type PlatformUpload,
  type ReconcileResult,
  type MasterProduct,
} from "@/lib/availability-reconcile";

// Overlay platforms (everything except the Malika master) keep their availability
// in the shared `platform_status` overlay (platform, availability). Malika is the
// Snoonu master itself — its real stock lives in `inventory`, so we don't fake it
// here; the per-platform correction list tells the user what to hide on Malika.
const OVERLAY = PLATFORMS.filter((p) => !p.master).map((p) => p.key);

const PAGE = 1000;

// Read-only: match the uploaded platform lists against the master catalog and
// reconcile availability with "out anywhere = out everywhere". Returns the full
// matrix (display-capped) plus uncapped ids/corrections for apply + CSV export.
export async function reconcileAvailabilityAction(
  uploads: PlatformUpload[]
): Promise<{ ok: boolean; error?: string; result?: ReconcileResult; matrixCapped?: boolean }> {
  try {
    const sb = createClient();
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return { ok: false, error: "غير مسجّل الدخول." };
    if (!uploads?.some((u) => (u.rows ?? []).length)) return { ok: false, error: "ما في أي قائمة مرفوعة." };

    const masters: MasterProduct[] = [];
    for (let f = 0; ; f += PAGE) {
      const { data, error } = await sb
        .from("products")
        .select("id, snoonu_id, rafeeq_product_id, sku, barcode, name_en, name_ar, image_url")
        .range(f, f + PAGE - 1);
      if (error) return { ok: false, error: error.message };
      masters.push(...((data ?? []) as MasterProduct[]));
      if ((data ?? []).length < PAGE) break;
    }

    const full = reconcile(masters, uploads);
    // Cap only the displayed matrix; counts/ids/corrections stay complete.
    const CAP = 1500;
    const result: ReconcileResult = { ...full, matrix: full.matrix.slice(0, CAP) };
    return { ok: true, result, matrixCapped: full.matrix.length > CAP };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "خطأ غير متوقع." };
  }
}

// Write the reconciled availability onto every overlay platform so the whole
// system reflects one truth. OutOfStock / InStock only — approval/rejection are
// never touched. Requires once in Supabase:
//   alter table platform_status add column if not exists availability text;
export async function applyReconciledAvailability(
  outIds: string[],
  inIds: string[]
): Promise<{ ok?: boolean; error?: string; platforms: number; outOfStock: number; inStock: number; failed?: number }> {
  const sb = createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return { error: "غير مسجّل الدخول.", platforms: 0, outOfStock: 0, inStock: 0 };

  const out = [...new Set((outIds ?? []).filter(Boolean))];
  const inn = [...new Set((inIds ?? []).filter(Boolean))];
  if (out.length + inn.length === 0) return { error: "ما في منتجات لتطبيقها.", platforms: 0, outOfStock: 0, inStock: 0 };

  const now = new Date().toISOString();
  const rows: { product_id: string; platform: string; availability: string; updated_at: string }[] = [];
  for (const platform of OVERLAY) {
    for (const id of out) rows.push({ product_id: id, platform, availability: "OutOfStock", updated_at: now });
    for (const id of inn) rows.push({ product_id: id, platform, availability: "InStock", updated_at: now });
  }

  let failed = 0, firstErr = "";
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await sb.from("platform_status").upsert(chunk, { onConflict: "product_id,platform" });
    if (error) { failed += chunk.length; if (!firstErr) firstErr = error.message; }
  }
  if (firstErr) {
    const hint = /availability/.test(firstErr)
      ? " — شغّل في Supabase: alter table platform_status add column if not exists availability text;"
      : "";
    return { error: firstErr + hint, platforms: OVERLAY.length, outOfStock: 0, inStock: 0, failed };
  }

  for (const p of OVERLAY) revalidatePath(`/platforms/${p}`);
  return { ok: true, platforms: OVERLAY.length, outOfStock: out.length, inStock: inn.length, failed };
}

// Push the reconciled out-of-stock to Shopify: set 0 stock for each SKU (real,
// env-gated API call) and mark the product Not Listed on the Shopify channel so
// everything matches across platforms. SKUs of reconciled-out products only.
export async function applyReconciledToShopify(
  outSkus: string[]
): Promise<{ ok?: boolean; error?: string; channelRows: number; shopify: { configured: boolean; pushed?: number; failed?: number; message?: string } }> {
  const sb = createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return { error: "غير مسجّل الدخول.", channelRows: 0, shopify: { configured: false } };

  const skus = [...new Set((outSkus ?? []).filter(Boolean))];
  if (skus.length === 0) return { error: "ما في SKU نافدة.", channelRows: 0, shopify: { configured: false } };

  // Mark Not Listed on the Shopify channel for these SKUs (in-system).
  let channelRows = 0;
  const { data: chans } = await sb.from("channels").select("id, name").ilike("name", "%shopify%");
  const shopifyChan = (chans ?? [])[0] as { id: string } | undefined;
  if (shopifyChan) {
    const { data: prods } = await sb.from("products").select("id, sku").in("sku", skus);
    const ids = ((prods ?? []) as any[]).map((p) => p.id).filter(Boolean);
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const { error } = await sb
        .from("channel_products")
        .update({ channel_status: "Not Listed" })
        .eq("channel_id", shopifyChan.id)
        .in("product_id", chunk)
        .eq("channel_status", "Active");
      if (!error) channelRows += chunk.length;
    }
  }

  // Real, env-gated push of 0 stock to Shopify.
  const res = await pushStockToShopify(skus.map((sku) => ({ sku, quantity: 0 })));
  const shopify = res.configured
    ? { configured: true, pushed: res.pushed, failed: res.failed }
    : { configured: false, message: res.message };

  revalidatePath("/channels");
  revalidatePath("/platforms/shopify");
  return { ok: true, channelRows, shopify };
}

export interface SystemOosResult {
  ok?: boolean; error?: string;
  outSkus: number;
  channelRows: number;
  shopify: { configured: boolean; pushed?: number; failed?: number; message?: string };
}

// Push the OUT-OF-STOCK products already recorded in the system (any overlay
// platform's platform_status.availability = 'OutOfStock') to Shopify — set stock
// 0 + mark Not Listed — WITHOUT re-uploading any file. This is the "apply the
// out-of-stock that's already in the system onto Shopify" one-tap.
export async function applySystemOutOfStockToShopify(): Promise<SystemOosResult> {
  const base: SystemOosResult = { outSkus: 0, channelRows: 0, shopify: { configured: false } };
  const sb = createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return { ...base, error: "غير مسجّل الدخول." };

  // Product ids flagged out-of-stock on ANY overlay platform (Pure Seoul, Talabat…).
  const outIds = new Set<string>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from("platform_status")
      .select("product_id").eq("availability", "OutOfStock").range(from, from + PAGE - 1);
    if (error) {
      if (/availability/.test(error.message)) {
        return { ...base, error: "عمود availability غير موجود — شغّل: alter table platform_status add column if not exists availability text;" };
      }
      return { ...base, error: error.message };
    }
    for (const r of data ?? []) { const pid = (r as { product_id?: string }).product_id; if (pid) outIds.add(String(pid)); }
    if ((data ?? []).length < PAGE) break;
  }
  if (outIds.size === 0) return { ...base, ok: true, error: "ما في منتجات نافدة مخزّنة في النظام." };

  // Resolve their SKUs.
  const ids = [...outIds];
  const skus: string[] = [];
  for (let i = 0; i < ids.length; i += 300) {
    const { data } = await sb.from("products").select("sku").in("id", ids.slice(i, i + 300));
    for (const p of (data ?? []) as { sku?: string }[]) if (p.sku) skus.push(String(p.sku));
  }
  if (skus.length === 0) return { ...base, ok: true, error: "المنتجات النافدة ما لها SKU." };

  const r = await applyReconciledToShopify([...new Set(skus)]);
  return { ok: r.ok, error: r.error, outSkus: new Set(skus).size, channelRows: r.channelRows, shopify: r.shopify };
}
