import { createClient } from "@/lib/supabase/server";
import ContentGenerator, { type PickProduct } from "@/components/ContentGenerator";

export const dynamic = "force-dynamic";

export default async function ContentPage() {
  const supabase = createClient();

  // Lightweight product list for the SKU search (read-only on products).
  const items: PickProduct[] = [];
  let loadError: string | null = null;
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("products")
      .select("sku, name_en, name_ar, price, main_category, image_url")
      .order("name_en")
      .range(from, from + PAGE - 1);
    if (error) {
      loadError = error.message;
      break;
    }
    for (const r of (data ?? []) as any[]) {
      if (!r.sku) continue;
      items.push({
        sku: r.sku,
        name_en: r.name_en ?? null,
        name_ar: r.name_ar ?? null,
        price: r.price ?? null,
        category: r.main_category ?? null,
        image_url: r.image_url ?? null,
      });
    }
    if (!data || data.length < PAGE) break;
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-ink">مولّد المحتوى · Content generator</h2>
        <p className="text-sm text-muted">
          اختر منتج → يولّد كابشن إنستجرام (عربي + إنجليزي + هاشتاقات)، ثم انسخه. الصورة والفيديو قريبًا عبر Higgsfield.
        </p>
      </div>

      {loadError ? (
        <div className="card border-amber-200 bg-amber-50 text-sm text-amber-800">
          Couldn’t load products: {loadError}.
        </div>
      ) : (
        <ContentGenerator items={items} />
      )}
    </div>
  );
}
