import { notFound } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { effectivePrice, priceRangeLabel, type PricedVariant } from "@/lib/products/price-compute";
import ProductImageActions from "@/components/ProductImageActions";

export const dynamic = "force-dynamic";

function Field({ label, value, rtl }: { label: string; value: unknown; rtl?: boolean }) {
  const empty = value === null || value === undefined || value === "";
  return (
    <div>
      <dt className="text-xs font-medium uppercase text-muted">{label}</dt>
      <dd className={`mt-0.5 whitespace-pre-wrap text-sm ${empty ? "text-slate-300" : "text-ink"}`} dir={rtl ? "rtl" : undefined}>
        {empty ? "—" : String(value)}
      </dd>
    </div>
  );
}

const STATUS_CLS: Record<string, string> = {
  Active: "bg-green-100 text-green-700",
  Draft: "bg-amber-100 text-amber-700",
  "Not Listed": "bg-slate-100 text-slate-500",
};

export default async function ProductDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = createClient();

  const [{ data: product }, { data: variants }, { data: brands }, { data: inv }, { data: channels }, { data: links }, { data: images }] =
    await Promise.all([
      supabase.from("products").select("*").eq("id", id).single(),
      supabase.from("product_variants").select("*").eq("parent_product_id", id),
      supabase.from("brands").select("id, name"),
      supabase.from("inventory").select("stock_quantity, low_stock_threshold, sold_quantity, updated_at").eq("product_id", id).maybeSingle(),
      supabase.from("channels").select("id, name").order("name"),
      supabase.from("channel_products").select("channel_id, channel_status, channel_price").eq("product_id", id),
      supabase.from("product_images").select("url, is_primary, sort_order").eq("product_id", id).order("is_primary", { ascending: false }).order("sort_order", { ascending: true }),
    ]);

  if (!product) notFound();

  // Gallery: primary/sort-ordered product_images, falling back to products.image_url.
  const galleryUrls: string[] = [];
  for (const im of images ?? []) if (im.url && !galleryUrls.includes(im.url)) galleryUrls.push(im.url);
  if (product.image_url && !galleryUrls.includes(product.image_url)) galleryUrls.unshift(product.image_url);
  const heroUrl = galleryUrls[0] ?? null;

  // Selling price shown to staff: when the product has priced options, the price
  // comes FROM the options (a range); otherwise from the parent product's price.
  const priceEff = effectivePrice(product.price, product.discount_price, (variants ?? []) as PricedVariant[]);
  const priceLabel = priceRangeLabel(priceEff, (n) => `${n} QAR`);

  const brandName = (brands ?? []).find((b: any) => b.id === product.brand_id)?.name ?? null;
  const statusByChannel = (channels ?? []).map((c: any) => ({
    name: c.name,
    status: (links ?? []).find((l: any) => l.channel_id === c.id)?.channel_status ?? "Not Listed",
  }));

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <Link href="/products" className="text-sm text-brand hover:underline">← All products</Link>
          <h2 className="text-xl font-semibold text-ink">{product.name_en ?? "Product"}</h2>
          <p className="text-sm text-muted" dir="rtl">{product.name_ar ?? ""}</p>
          <p className="mt-1 text-sm font-semibold text-ink tabular-nums">
            {priceLabel}
            {priceEff.fromVariants ? (
              <span className="ms-1 rounded bg-violet-100 px-1.5 py-0.5 text-[11px] font-medium text-violet-700">🎚️ from options</span>
            ) : null}
          </p>
        </div>
        <Link href={`/products/${product.id}/edit`} className="btn-primary w-full sm:w-auto">Edit</Link>
      </div>

      {/* Image */}
      <div className="card">
        {heroUrl ? (
          <div className="space-y-3">
            {/* Fixed-height box owns the size; img fills it with object-contain. */}
            <div className="flex h-80 w-full items-center justify-center overflow-hidden rounded-lg bg-slate-50 sm:h-96">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={heroUrl}
                alt={product.name_en ?? product.sku ?? "product"}
                loading="lazy"
                className="block h-full w-full object-contain"
              />
            </div>
            <ProductImageActions url={heroUrl} name={product.sku || product.name_en || "product"} />
            {galleryUrls.length > 1 ? (
              <div className="flex flex-wrap gap-2">
                {galleryUrls.map((u, i) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={i} src={u} alt={`image ${i + 1}`} loading="lazy"
                    width={64} height={64}
                    className="block h-16 w-16 max-w-none shrink-0 rounded-sm object-cover ring-1 ring-slate-200" />
                ))}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="flex h-40 items-center justify-center rounded-lg bg-slate-50 text-slate-300">
            <span className="text-sm">📦 No image</span>
          </div>
        )}
      </div>

      {/* Channel status */}
      <div className="card">
        <h3 className="mb-3 text-sm font-semibold text-ink">Channel status</h3>
        <div className="flex flex-wrap gap-2">
          {statusByChannel.map((c, i) => (
            <span key={i} className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-1.5 text-sm">
              <span className="text-slate-600">{c.name}</span>
              <span className={`badge ${STATUS_CLS[c.status] ?? "bg-slate-100 text-slate-500"}`}>{c.status}</span>
            </span>
          ))}
        </div>
        <p className="mt-2 text-xs text-muted">Stock is shared across all channels (single inventory pool).</p>
      </div>

      {/* All 28 fields */}
      <div className="card">
        <h3 className="mb-4 text-sm font-semibold text-ink">All fields</h3>
        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="SKU" value={product.sku} />
          <Field label="Snoonu ID" value={product.snoonu_id} />
          <Field label="Barcode" value={product.barcode} />
          <Field label="Name (EN)" value={product.name_en} />
          <Field label="Name (AR)" value={product.name_ar} rtl />
          <Field label="Brand" value={brandName} />
          <Field label="Main Category" value={product.main_category} />
          <Field label="Sub Category" value={product.sub_category} />
          <Field label="Product Type" value={product.product_type} />
          <Field label="Color" value={product.color} />
          <Field label="Size" value={product.size} />
          <Field label="Price" value={product.price} />
          <Field label="Discount Price" value={product.discount_price} />
          <Field label="Cost" value={product.cost} />
          <Field label="Stock Quantity (product)" value={product.stock_quantity} />
          <Field label="Stock Status" value={product.stock_status} />
          <Field label="Platform Status" value={product.platform_status} />
          <Field label="Image Filename" value={product.image_filename} />
          <Field label="Image URL" value={product.image_url} />
          <Field label="Description (EN)" value={product.description_en} />
          <Field label="Description (AR)" value={product.description_ar} rtl />
          <Field label="Keywords (EN)" value={product.keywords_en} />
          <Field label="Keywords (AR)" value={product.keywords_ar} rtl />
          <Field label="Notes" value={product.notes} />
          <Field label="Created At" value={product.created_at} />
          <Field label="Updated At" value={product.updated_at} />
          <Field label="ID" value={product.id} />
        </dl>
      </div>

      {/* Inventory (single source of stock truth) */}
      <div className="card">
        <h3 className="mb-3 text-sm font-semibold text-ink">Inventory (shared pool)</h3>
        {inv ? (
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Field label="Stock" value={inv.stock_quantity} />
            <Field label="Low Threshold" value={inv.low_stock_threshold} />
            <Field label="Sold" value={inv.sold_quantity} />
            <Field label="Updated" value={inv.updated_at} />
          </dl>
        ) : (
          <p className="text-sm text-slate-400">No inventory row.</p>
        )}
      </div>

      {/* Variants */}
      <div className="card">
        <h3 className="mb-3 text-sm font-semibold text-ink">Variants ({(variants ?? []).length})</h3>
        {(variants ?? []).length === 0 ? (
          <p className="text-sm text-slate-400">No variants — sold as a single item.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase text-muted">
                  <th className="px-3 py-2 font-medium">Variant</th>
                  <th className="px-3 py-2 font-medium">SKU</th>
                  <th className="px-3 py-2 font-medium">Barcode</th>
                  <th className="px-3 py-2 font-medium">Color</th>
                  <th className="px-3 py-2 font-medium">Size</th>
                  <th className="px-3 py-2 font-medium">Price</th>
                </tr>
              </thead>
              <tbody>
                {(variants ?? []).map((v: any) => (
                  <tr key={v.id} className="border-b border-slate-100">
                    <td className="px-3 py-2 text-ink">{v.variant_name ?? "—"}</td>
                    <td className="px-3 py-2 text-slate-600">{v.sku ?? "—"}</td>
                    <td className="px-3 py-2 font-mono text-slate-600">{v.barcode ?? "—"}</td>
                    <td className="px-3 py-2 text-slate-600">{v.color ?? "—"}</td>
                    <td className="px-3 py-2 text-slate-600">{v.size ?? "—"}</td>
                    <td className="px-3 py-2 text-slate-600">{v.price ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
