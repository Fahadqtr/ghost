import { createClient } from "@/lib/supabase/server";
import ExcelImport from "@/components/ExcelImport";
import ImageUpload from "@/components/ImageUpload";
import ExportButtons, { type ExportProduct } from "@/components/ExportButtons";

export const dynamic = "force-dynamic";

export default async function ImportExportPage() {
  const supabase = createClient();

  const [{ data: productList }, { data: full }] = await Promise.all([
    supabase.from("products").select("id, name_en").order("name_en").limit(1000),
    supabase
      .from("products")
      .select(
        "sku, barcode, name_en, name_ar, main_category, price, discount_price, stock_quantity, image_url, product_variants(variant_name, sku, price, stock_quantity)"
      )
      .limit(1000),
  ]);

  const exportProducts: ExportProduct[] = (full ?? []).map((p: any) => ({
    sku: p.sku,
    barcode: p.barcode,
    name_en: p.name_en,
    name_ar: p.name_ar,
    main_category: p.main_category,
    price: p.price,
    discount_price: p.discount_price,
    stock_quantity: p.stock_quantity,
    image_url: p.image_url,
    variants: (p.product_variants ?? []).map((v: any) => ({
      variant_name: v.variant_name,
      sku: v.sku,
      price: v.price,
      stock_quantity: v.stock_quantity,
    })),
  }));

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted">
        Placeholder import/export flows for Phase 1. No real marketplace API is called anywhere.
      </p>
      <ExcelImport />
      <ImageUpload products={(productList ?? []) as { id: string; name_en: string | null }[]} />
      <ExportButtons products={exportProducts} />
    </div>
  );
}
