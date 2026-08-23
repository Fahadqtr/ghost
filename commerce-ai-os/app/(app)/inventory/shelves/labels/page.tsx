import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import ShelfLabels, { type LabelItem } from "@/components/ShelfLabels";

export const dynamic = "force-dynamic";

export default async function ShelfLabelsPage() {
  const supabase = createClient();

  const probe = await supabase.from("inventory").select("location").limit(1);
  const ready = !probe.error;

  const items: LabelItem[] = [];
  if (ready) {
    const PAGE = 1000;
    const prodById = new Map<string, Omit<LabelItem, "location" | "quantity" | "id">>();
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from("inventory")
        .select("id, stock_quantity, location, products(name_en, name_ar, sku, barcode, image_url)")
        .range(from, from + PAGE - 1);
      if (error) break;
      for (const r of (data ?? []) as any[]) {
        prodById.set(r.id, {
          name: r.products?.name_en ?? r.products?.name_ar ?? null,
          name_ar: r.products?.name_ar ?? null,
          sku: r.products?.sku ?? null,
          barcode: r.products?.barcode ?? null,
          image_url: r.products?.image_url ?? null,
          total: r.stock_quantity ?? 0,
        });
      }
      if (!data || data.length < PAGE) break;
    }

    const hasShelfStock = !(await supabase.from("shelf_stock").select("id").limit(1)).error;
    if (hasShelfStock) {
      for (let from = 0; ; from += PAGE) {
        const { data: ss, error } = await supabase
          .from("shelf_stock")
          .select("inventory_id, location, quantity")
          .range(from, from + PAGE - 1);
        if (error) break;
        for (const r of (ss ?? []) as any[]) {
          const p = prodById.get(r.inventory_id);
          if (!p) continue;
          items.push({ ...p, id: r.inventory_id, location: String(r.location).toUpperCase(), quantity: r.quantity ?? 0 });
        }
        if (!ss || ss.length < PAGE) break;
      }
    } else {
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from("inventory")
          .select("id, stock_quantity, location, products(name_en, name_ar, sku, barcode, image_url)")
          .not("location", "is", null)
          .range(from, from + PAGE - 1);
        if (error) break;
        for (const r of (data ?? []) as any[]) {
          items.push({
            id: r.id,
            location: String(r.location).toUpperCase(),
            name: r.products?.name_en ?? r.products?.name_ar ?? null,
            name_ar: r.products?.name_ar ?? null,
            sku: r.products?.sku ?? null,
            barcode: r.products?.barcode ?? null,
            image_url: r.products?.image_url ?? null,
            quantity: r.stock_quantity ?? 0,
            total: r.stock_quantity ?? 0,
          });
        }
        if (!data || data.length < PAGE) break;
      }
    }

    // Variant-level shelf labels — products with options distribute their stock
    // per variant in variant_shelf_stock, so they never show up in the
    // product-level shelf_stock above. Pull them in with each variant's own
    // barcode, labelled "Parent · Variant". Non-fatal if the table is absent.
    const hasVariantShelf = !(await supabase.from("variant_shelf_stock").select("id").limit(1)).error;
    if (hasVariantShelf) {
      const vMeta = new Map<
        string,
        { variant_name: string | null; sku: string | null; barcode: string | null; parent: string | null; total: number }
      >();
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from("product_variants")
          .select("id, variant_name, sku, barcode, parent_product_id, stock_quantity")
          .range(from, from + PAGE - 1);
        if (error) break;
        for (const r of (data ?? []) as any[]) {
          vMeta.set(r.id, {
            variant_name: r.variant_name ?? null,
            sku: r.sku ?? null,
            barcode: r.barcode ?? null,
            parent: r.parent_product_id ?? null,
            total: r.stock_quantity ?? 0,
          });
        }
        if (!data || data.length < PAGE) break;
      }

      const parentIds = Array.from(new Set([...vMeta.values()].map((v) => v.parent).filter(Boolean))) as string[];
      const parentById = new Map<string, { name: string | null; name_ar: string | null; image_url: string | null }>();
      for (let i = 0; i < parentIds.length; i += 300) {
        const chunk = parentIds.slice(i, i + 300);
        const { data } = await supabase.from("products").select("id, name_en, name_ar, image_url").in("id", chunk);
        for (const p of (data ?? []) as any[])
          parentById.set(p.id, { name: p.name_en ?? p.name_ar ?? null, name_ar: p.name_ar ?? null, image_url: p.image_url ?? null });
      }

      for (let from = 0; ; from += PAGE) {
        const { data: vs, error } = await supabase
          .from("variant_shelf_stock")
          .select("variant_id, location, quantity")
          .range(from, from + PAGE - 1);
        if (error) break;
        for (const r of (vs ?? []) as any[]) {
          const v = vMeta.get(r.variant_id);
          if (!v) continue;
          const par = v.parent ? parentById.get(v.parent) : null;
          const name = par?.name && v.variant_name ? `${par.name} · ${v.variant_name}` : v.variant_name ?? par?.name ?? null;
          const name_ar =
            par?.name_ar && v.variant_name ? `${par.name_ar} · ${v.variant_name}` : par?.name_ar ?? v.variant_name ?? null;
          items.push({
            id: r.variant_id,
            location: String(r.location).toUpperCase(),
            name,
            name_ar,
            sku: v.sku ?? null,
            barcode: v.barcode ?? null,
            image_url: par?.image_url ?? null,
            quantity: r.quantity ?? 0,
            total: v.total,
          });
        }
        if (!vs || vs.length < PAGE) break;
      }
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 print:hidden">
        <p className="text-sm text-muted">
          Printable shelf labels — product image, name and a scannable barcode, grouped by shelf. Each shelf
          starts on a new page so you can cut and stick them.
        </p>
        <Link href="/v2/inventory/shelves" className="btn-ghost px-3 py-1 text-xs whitespace-nowrap">
          ← Back to shelves
        </Link>
      </div>

      {!ready ? (
        <div className="card text-sm text-amber-800">Run the shelf-locations setup first (Shelves page).</div>
      ) : (
        <ShelfLabels items={items} />
      )}
    </div>
  );
}
