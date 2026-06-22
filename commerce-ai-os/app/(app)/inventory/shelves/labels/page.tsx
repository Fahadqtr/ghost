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
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from("inventory")
        .select("location, products(name_en, name_ar, sku, barcode, image_url)")
        .not("location", "is", null)
        .range(from, from + PAGE - 1);
      if (error) break;
      for (const r of (data ?? []) as any[]) {
        items.push({
          location: String(r.location).toUpperCase(),
          name: r.products?.name_en ?? r.products?.name_ar ?? null,
          name_ar: r.products?.name_ar ?? null,
          sku: r.products?.sku ?? null,
          barcode: r.products?.barcode ?? null,
          image_url: r.products?.image_url ?? null,
        });
      }
      if (!data || data.length < PAGE) break;
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 print:hidden">
        <p className="text-sm text-muted">
          Printable shelf labels — product image, name and a scannable barcode, grouped by shelf. Each shelf
          starts on a new page so you can cut and stick them.
        </p>
        <Link href="/inventory/shelves" className="btn-ghost px-3 py-1 text-xs whitespace-nowrap">
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
