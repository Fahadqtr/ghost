import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import ShelvesManager, { type Slot } from "@/components/ShelvesManager";
import ShelfContents, { type ShelfItem } from "@/components/ShelfContents";

export const dynamic = "force-dynamic";

export default async function ShelvesPage() {
  const supabase = createClient();

  // Has the migration been run? (shelf_slots table + inventory.location)
  const probe = await supabase.from("shelf_slots").select("code").limit(1);
  const ready = !probe.error;

  let slots: Slot[] = [];
  const counts: Record<string, number> = {};
  const contents: ShelfItem[] = [];
  if (ready) {
    const { data } = await supabase.from("shelf_slots").select("code, shelf, sort").order("shelf").order("sort");
    slots = ((data ?? []) as any[]).map((s) => ({ code: String(s.code), shelf: String(s.shelf) }));

    // Products assigned to a location, with name + barcode (page through the cap).
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data: inv, error } = await supabase
        .from("inventory")
        .select("location, products(name_en, name_ar, sku, barcode)")
        .not("location", "is", null)
        .range(from, from + PAGE - 1);
      if (error) break;
      for (const r of (inv ?? []) as any[]) {
        const code = String(r.location).toUpperCase();
        counts[code] = (counts[code] ?? 0) + 1;
        contents.push({
          location: code,
          name: r.products?.name_en ?? r.products?.name_ar ?? null,
          name_ar: r.products?.name_ar ?? null,
          sku: r.products?.sku ?? null,
          barcode: r.products?.barcode ?? null,
        });
      }
      if (!inv || inv.length < PAGE) break;
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted">
          Shelf map — define your shelves (A, B, C…) and their slots (A1, A2…), then assign products to
          slots from the inventory table.
        </p>
        <div className="flex items-center gap-2">
          <Link href="/inventory/shelves/labels" className="btn-ghost px-3 py-1 text-xs whitespace-nowrap">
            🖨️ Print labels
          </Link>
          <Link href="/inventory" className="btn-ghost px-3 py-1 text-xs whitespace-nowrap">
            ← Back to inventory
          </Link>
        </div>
      </div>

      {!ready ? (
        <div className="card space-y-2 border-amber-200 bg-amber-50 text-sm text-amber-800">
          <div className="font-medium">One-time setup needed</div>
          <p>
            Run <code className="rounded bg-white px-1">supabase/shelf_locations.sql</code> once in your
            Supabase SQL editor to add the <code>location</code> column and the <code>shelf_slots</code> table,
            then refresh this page.
          </p>
        </div>
      ) : (
        <>
          <ShelvesManager slots={slots} counts={counts} />
          <ShelfContents items={contents} />
        </>
      )}
    </div>
  );
}
