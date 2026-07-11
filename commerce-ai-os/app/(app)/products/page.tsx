import { createClient } from "@/lib/supabase/server";
import ProductTable, { type ProductRow } from "@/components/ProductTable";
import Link from "next/link";
import { getInventoryMode } from "@/lib/settings";
import { effectivePrice, type PricedVariant } from "@/lib/products/price-compute";
import { getT } from "@/lib/i18n-server";

export const dynamic = "force-dynamic";

const PAGE = 1000;
async function fetchAll(q: (from: number, to: number) => any): Promise<any[]> {
  const out: any[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await q(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if ((data ?? []).length < PAGE) break;
  }
  return out;
}

export default async function ProductsPage({ searchParams }: { searchParams: Promise<{ review?: string }> }) {
  const supabase = createClient();
  const { locale } = await getT();
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);
  const initialGroup = (await searchParams).review === "staff" ? "staff_pending" : "";
  const simpleMode = (await getInventoryMode()) === "simple";

  let products: ProductRow[] = [];
  let errMsg: string | null = null;

  try {
    const [rows, channels, links, variantRows] = await Promise.all([
      fetchAll((from, to) =>
        supabase
          .from("products")
          .select(
            "id, sku, snoonu_id, barcode, name_en, name_ar, main_category, approval, rejection_reason, platform_status, notes, price, discount_price, image_url, product_variants(count), inventory(stock_quantity)"
          )
          .order("sku", { ascending: true })
          .range(from, to)
      ),
      supabase.from("channels").select("id, name"),
      fetchAll((from, to) =>
        supabase.from("channel_products").select("product_id, channel_id, channel_status").range(from, to)
      ),
      fetchAll((from, to) =>
        supabase.from("product_variants").select("parent_product_id, variant_name, barcode, price").range(from, to)
      ),
    ]);

    // parent_product_id -> [{name, barcode}] (for barcode search + showing which option matched)
    const variantsByProduct = new Map<string, { name: string | null; barcode: string }[]>();
    // parent_product_id -> [{price, discount_price}] (ALL options, for the effective price)
    const pricesByProduct = new Map<string, PricedVariant[]>();
    for (const v of variantRows as any[]) {
      if (!v?.parent_product_id) continue;
      const pArr = pricesByProduct.get(v.parent_product_id) ?? [];
      pArr.push({ price: v.price });
      pricesByProduct.set(v.parent_product_id, pArr);
      const bc = v?.barcode ? String(v.barcode).trim() : "";
      if (!bc) continue;
      const arr = variantsByProduct.get(v.parent_product_id) ?? [];
      arr.push({ name: v.variant_name ?? null, barcode: bc });
      variantsByProduct.set(v.parent_product_id, arr);
    }

    const chanList = (channels as any).data ?? [];
    const idToName = new Map<string, string>(chanList.map((c: any) => [c.id, c.name]));

    // product_id -> { channelName: status }
    const statusByProduct = new Map<string, Record<string, string>>();
    for (const l of links) {
      const name = idToName.get(l.channel_id);
      if (!name) continue;
      if (!statusByProduct.has(l.product_id)) statusByProduct.set(l.product_id, {});
      statusByProduct.get(l.product_id)![name] = l.channel_status ?? "Not Listed";
    }

    products = rows.map((p: any) => ({
      id: p.id,
      image_url: p.image_url,
      sku: p.sku,
      snoonu_id: p.snoonu_id,
      barcode: p.barcode,
      name_en: p.name_en,
      name_ar: p.name_ar,
      main_category: p.main_category,
      approval: p.approval,
      rejection_reason: p.rejection_reason,
      platform_status: p.platform_status,
      notes: p.notes,
      price: p.price,
      discount_price: p.discount_price,
      priceEff: effectivePrice(p.price, p.discount_price, pricesByProduct.get(p.id)),
      stock: p.inventory?.[0]?.stock_quantity ?? null,
      variant_count: p.product_variants?.[0]?.count ?? 0,
      variants: variantsByProduct.get(p.id) ?? [],
      channels: statusByProduct.get(p.id) ?? {},
    }));
  } catch (e) {
    errMsg = e instanceof Error ? e.message : L("تعذّر تحميل المنتجات.", "Failed to load products.");
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted">{L("أدِر كتالوج منتجاتك (نسخة من ملف الـ 28 عمود الرئيسي).", "Manage your product catalog (mirror of the 28-column master sheet).")}</p>
        <Link href="/products/new" className="btn-primary w-full sm:w-auto">{L("+ منتج جديد", "+ New product")}</Link>
      </div>

      {errMsg ? (
        <div className="card border-amber-200 bg-amber-50 text-sm text-amber-800">
          {L(`تعذّر تحميل المنتجات: ${errMsg}. تأكّد أنك مسجّل الدخول (RLS).`, `Couldn’t load products: ${errMsg}. Make sure you’re signed in (RLS).`)}
        </div>
      ) : (
        <ProductTable products={products} locale={locale} initialGroup={initialGroup} simpleMode={simpleMode} />
      )}
    </div>
  );
}
