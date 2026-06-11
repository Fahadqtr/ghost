"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { PLATFORM_KEYS, platformBy, type PlatformKey } from "@/lib/constants";

// Per-platform Product Hub backend.
//
// MASTER = Malika: the `products` table holds the shared product data AND
// Malika's own approval (products.approval / products.rejection_reason). Every
// OTHER platform keeps ONLY its approval/rejection in a generalized overlay
// table, so the same product can be Approved on one platform and Rejected on
// another without touching the master data. Run once in Supabase SQL editor:
//
//   create table if not exists platform_status (
//     product_id uuid not null references products(id) on delete cascade,
//     platform text not null,
//     approval text,
//     rejection_reason text,
//     updated_at timestamptz not null default now(),
//     primary key (product_id, platform)
//   );
//   alter table platform_status enable row level security;
//   create policy "platform_status_all" on platform_status
//     for all to authenticated using (true) with check (true);
//   -- migrate the earlier Pure Seoul table, if it exists:
//   insert into platform_status (product_id, platform, approval, rejection_reason, updated_at)
//     select product_id, 'pure_seoul', approval, rejection_reason, updated_at from pure_seoul_status
//     on conflict (product_id, platform) do nothing;

const APPROVAL = new Set(["", "Approved", "Rejected", "SentAI"]);

export interface PlatformProduct {
  id: string;
  sku: string | null;
  name_en: string | null;
  name_ar: string | null;
  main_category: string | null;
  price: number | null;
  image_url: string | null;
  approval: string | null;
  rejection_reason: string | null;
}

const PAGE = 1000;
async function fetchAllProducts(sb: ReturnType<typeof createClient>): Promise<any[]> {
  const out: any[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from("products")
      .select("id, sku, name_en, name_ar, main_category, price, image_url, approval, rejection_reason")
      .order("sku", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if ((data ?? []).length < PAGE) break;
  }
  return out;
}

// Master product data + the chosen platform's approval/rejection overlaid.
export async function getPlatformProducts(platform: string): Promise<{ error?: string; products: PlatformProduct[] }> {
  const meta = platformBy(platform);
  if (!meta) return { error: `منصة غير معروفة: ${platform}`, products: [] };
  const sb = createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return { error: "غير مسجّل الدخول.", products: [] };

  try {
    const rows = await fetchAllProducts(sb);
    if (meta.master) {
      // Malika = master: approval lives on the products row itself.
      return { products: rows.map((p) => ({ ...p })) as PlatformProduct[] };
    }
    // Overlay platform: pull its statuses and merge onto the master rows.
    const ov = new Map<string, { approval: string | null; rejection_reason: string | null }>();
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await sb
        .from("platform_status")
        .select("product_id, approval, rejection_reason")
        .eq("platform", platform)
        .range(from, from + PAGE - 1);
      if (error) return { error: error.message, products: [] };
      for (const r of data ?? []) ov.set(r.product_id, { approval: r.approval, rejection_reason: r.rejection_reason });
      if ((data ?? []).length < PAGE) break;
    }
    return {
      products: rows.map((p) => {
        const o = ov.get(p.id);
        return { ...p, approval: o?.approval ?? null, rejection_reason: o?.rejection_reason ?? null } as PlatformProduct;
      }),
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "تعذّر تحميل المنتجات.", products: [] };
  }
}

// Set approval (and optional reason) for a set of products ON ONE platform.
// Master platform writes the products table; others upsert the overlay.
export async function setPlatformApproval(ids: string[], platform: string, approval: string, reason?: string) {
  const meta = platformBy(platform);
  if (!meta) return { error: `منصة غير معروفة: ${platform}`, updated: 0 };
  if (!APPROVAL.has(approval)) return { error: `حالة غير صالحة: "${approval}".`, updated: 0 };
  const sb = createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return { error: "غير مسجّل الدخول.", updated: 0 };
  const list = (ids ?? []).filter(Boolean);
  if (list.length === 0) return { error: "ما في منتجات محدّدة.", updated: 0 };

  let updated = 0, failed = 0;
  if (meta.master) {
    const patch: Record<string, unknown> = { approval: approval === "" ? null : approval };
    if (reason !== undefined) patch.rejection_reason = reason.trim() || null;
    for (let i = 0; i < list.length; i += 200) {
      const chunk = list.slice(i, i + 200);
      const { error, count } = await sb.from("products").update(patch, { count: "exact" }).in("id", chunk);
      if (error) failed += chunk.length; else updated += count ?? chunk.length;
    }
    revalidatePath("/products");
    revalidatePath("/dashboard");
  } else {
    const now = new Date().toISOString();
    const rows = list.map((product_id) => ({
      product_id,
      platform,
      approval: approval === "" ? null : approval,
      rejection_reason: reason !== undefined ? (reason.trim() || null) : null,
      updated_at: now,
    }));
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      const { error } = await sb.from("platform_status").upsert(chunk, { onConflict: "product_id,platform" });
      if (error) failed += chunk.length; else updated += chunk.length;
    }
  }
  revalidatePath(`/platforms/${platform}`);
  return { ok: failed === 0, updated, failed };
}

// Bulk-reject for the paste/screenshot tool, scoped to a platform.
export async function rejectPlatformProducts(ids: string[], platform: string, reason: string) {
  return setPlatformApproval(ids, platform, "Rejected", reason);
}

export interface PlatformCounts { total: number; approved: number; rejected: number; none: number }

// Approval breakdown per platform for the index cards. Master (Malika) counts
// from products.approval; the rest from their platform_status rows (products
// with no overlay row count as "none"). One pass, head-count queries.
export async function getPlatformCounts(): Promise<Record<string, PlatformCounts>> {
  const out: Record<string, PlatformCounts> = {};
  const sb = createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return out;

  const head = async (build: (q: any) => any): Promise<number> => {
    const { count } = await build(sb.from("products").select("*", { count: "exact", head: true }));
    return count ?? 0;
  };
  const headPS = async (platform: string, approval: string): Promise<number> => {
    const { count } = await sb.from("platform_status")
      .select("*", { count: "exact", head: true }).eq("platform", platform).eq("approval", approval);
    return count ?? 0;
  };

  const total = await head((q) => q);

  for (const meta of PLATFORM_KEYS.map((k) => platformBy(k)!)) {
    if (meta.master) {
      const approved = await head((q) => q.eq("approval", "Approved"));
      const rejected = await head((q) => q.eq("approval", "Rejected"));
      out[meta.key] = { total, approved, rejected, none: Math.max(0, total - approved - rejected) };
    } else {
      const approved = await headPS(meta.key, "Approved");
      const rejected = await headPS(meta.key, "Rejected");
      // Anything without an Approved/Rejected overlay row is "no status yet".
      out[meta.key] = { total, approved, rejected, none: Math.max(0, total - approved - rejected) };
    }
  }
  return out;
}
