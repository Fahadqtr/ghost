// DUPLICATE RESOLUTION — read-only pair audit (SERVER-ONLY, OWNER-gated at
// the action).
//
// Snoonu Sync itself NEVER merges canonical products: an IDENTITY_COLLISION
// (e.g. mk2225 ↔ mk1983) is only surfaced. This module prepares the SEPARATE
// owner-controlled resolution workflow by auditing everything both products
// touch — identity, content, category, price, stock, variants, images,
// channel listings and export/package references — as a READ-ONLY preview.
// The owner then decides which canonical identity survives (the actual
// resolution runs through the certified archive path, exactly like the
// mk1016/mk2214 case, and is NOT implemented here).

import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

export interface DuplicateSideAudit {
  productId: string;
  sku: string;
  barcode: string | null;
  nameEn: string | null;
  nameAr: string | null;
  category: string | null;
  price: number | null;
  stockStatus: string | null;
  lifecycleState: string | null;
  imageUrl: string | null;
  createdAt: string | null;
  variantCount: number;
  listings: { storefrontKey: string; externalId: string | null; mappingStatus: string }[];
  /** rafeeq package item references (export history). null = table unavailable. */
  packageItemRefs: number | null;
  /** platform status rows (channel history). null = unavailable. */
  platformStatusRefs: number | null;
}

export interface DuplicatePairAudit {
  a: DuplicateSideAudit;
  b: DuplicateSideAudit;
  sameName: boolean;
  sameBarcode: boolean;
  note: string;
}

const num = async (p: PromiseLike<{ count: number | null; error: unknown }>): Promise<number | null> => {
  try {
    const { count, error } = await p;
    return error ? null : (count ?? 0);
  } catch {
    return null;
  }
};

async function auditSide(sku: string): Promise<DuplicateSideAudit | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("products")
    .select("id, sku, barcode, name_en, name_ar, main_category, price, stock_status, lifecycle_state, image_url, created_at")
    .eq("sku", sku)
    .maybeSingle();
  if (error || !data) return null;
  const r = data as Record<string, unknown>;
  const productId = String(r.id);
  const s = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

  const listingsRes = await admin
    .from("external_channel_listings")
    .select("storefront_key, external_product_id, mapping_status")
    .eq("product_id", productId);
  const listings = ((listingsRes.data ?? []) as Record<string, unknown>[]).map((l) => ({
    storefrontKey: String(l.storefront_key ?? ""),
    externalId: s(l.external_product_id),
    mappingStatus: String(l.mapping_status ?? ""),
  }));

  return {
    productId,
    sku: String(r.sku),
    barcode: s(r.barcode),
    nameEn: s(r.name_en),
    nameAr: s(r.name_ar),
    category: s(r.main_category),
    price: typeof r.price === "number" ? r.price : r.price == null ? null : Number(r.price),
    stockStatus: s(r.stock_status),
    lifecycleState: s(r.lifecycle_state),
    imageUrl: s(r.image_url),
    createdAt: s(r.created_at),
    variantCount: (await num(admin.from("product_variants").select("id", { count: "exact", head: true }).eq("parent_product_id", productId))) ?? 0,
    listings,
    packageItemRefs: await num(admin.from("rafeeq_package_items").select("id", { count: "exact", head: true }).eq("product_id", productId)),
    platformStatusRefs: await num(admin.from("platform_status").select("id", { count: "exact", head: true }).eq("product_id", productId)),
  };
}

/** READ-ONLY duplicate-pair audit. Never merges, never writes. */
export async function auditDuplicatePair(skuA: string, skuB: string): Promise<DuplicatePairAudit | null> {
  const [a, b] = await Promise.all([auditSide(skuA), auditSide(skuB)]);
  if (!a || !b || a.productId === b.productId) return null;
  return {
    a,
    b,
    sameName: !!a.nameEn && a.nameEn === b.nameEn,
    sameBarcode: !!a.barcode && a.barcode === b.barcode,
    note:
      "معاينة قراءة فقط — لا دمج ولا حذف هنا. القرار (أي هوية تبقى) للمالك، والتنفيذ يمر عبر مسار الأرشفة المعتمد في خطوة منفصلة مُصرَّح بها.",
  };
}
