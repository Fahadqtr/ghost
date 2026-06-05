import { notFound } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import ProductForm from "@/components/ProductForm";
import type { Brand } from "@/lib/types";
import type { ProductInput, VariantInput } from "@/app/(app)/products/actions";

export const dynamic = "force-dynamic";

// Convert nullable DB values into the string-based form shape.
const s = (v: unknown) => (v === null || v === undefined ? "" : String(v));

export default async function EditProductPage({
  params,
}: {
  params: { id: string };
}) {
  const supabase = createClient();

  const [{ data: product }, { data: variants }, { data: brands }] =
    await Promise.all([
      supabase.from("products").select("*").eq("id", params.id).single(),
      supabase.from("product_variants").select("*").eq("parent_product_id", params.id),
      supabase.from("brands").select("id, name").order("name"),
    ]);

  if (!product) notFound();

  const initial: Partial<ProductInput> = {
    sku: s(product.sku),
    barcode: s(product.barcode),
    name_en: s(product.name_en),
    name_ar: s(product.name_ar),
    brand_id: s(product.brand_id),
    main_category: s(product.main_category),
    sub_category: s(product.sub_category),
    product_type: s(product.product_type),
    color: s(product.color),
    size: s(product.size),
    price: s(product.price),
    discount_price: s(product.discount_price),
    cost: s(product.cost),
    stock_quantity: s(product.stock_quantity),
    stock_status: s(product.stock_status),
    platform_status: s(product.platform_status),
    image_filename: s(product.image_filename),
    image_url: s(product.image_url),
    description_en: s(product.description_en),
    description_ar: s(product.description_ar),
    keywords_en: s(product.keywords_en),
    keywords_ar: s(product.keywords_ar),
    notes: s(product.notes),
    variants: (variants ?? []).map(
      (v: any): VariantInput => ({
        id: v.id,
        variant_name: s(v.variant_name),
        sku: s(v.sku),
        color: s(v.color),
        size: s(v.size),
        price: s(v.price),
        stock_quantity: s(v.stock_quantity),
      })
    ),
  };

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-ink">Edit · {product.name_en ?? "product"}</h2>
        <Link href={`/products/${product.id}`} className="text-sm text-brand hover:underline">← Back to detail</Link>
      </div>
      <ProductForm brands={(brands ?? []) as Brand[]} productId={product.id} initial={initial} />
    </div>
  );
}
