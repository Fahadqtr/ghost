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
  // Distinct products per slot (the UI labels this number "products"). Track a
  // Set of inventory ids so a product that happens to have two rows for the same
  // slot isn't counted twice.
  const slotProducts: Record<string, Set<string>> = {};
  const counts: Record<string, number> = {};
  const contents: ShelfItem[] = [];
  if (ready) {
    const { data } = await supabase.from("shelf_slots").select("code, shelf, sort").order("shelf").order("sort");
    slots = ((data ?? []) as any[]).map((s) => ({ code: String(s.code), shelf: String(s.shelf) }));

    // Product details by inventory id (name, barcode, total stock).
    const PAGE = 1000;
    const prodById = new Map<string, { name: string | null; name_ar: string | null; sku: string | null; barcode: string | null; image: string | null; total: number }>();
    for (let from = 0; ; from += PAGE) {
      const { data: inv, error } = await supabase
        .from("inventory")
        .select("id, stock_quantity, location, products(name_en, name_ar, sku, barcode, image_url)")
        .range(from, from + PAGE - 1);
      if (error) break;
      for (const r of (inv ?? []) as any[]) {
        prodById.set(r.id, {
          name: r.products?.name_en ?? r.products?.name_ar ?? null,
          name_ar: r.products?.name_ar ?? null,
          sku: r.products?.sku ?? null,
          barcode: r.products?.barcode ?? null,
          image: r.products?.image_url ?? null,
          total: r.stock_quantity ?? 0,
        });
      }
      if (!inv || inv.length < PAGE) break;
    }

    // Prefer the per-shelf distribution (shelf_stock); fall back to the single
    // location column if that table isn't set up yet.
    const hasShelfStock = !(await supabase.from("shelf_stock").select("id").limit(1)).error;
    if (hasShelfStock) {
      for (let from = 0; ; from += PAGE) {
        const { data: ss, error } = await supabase
          .from("shelf_stock")
          .select("inventory_id, location, quantity")
          .range(from, from + PAGE - 1);
        if (error) break;
        for (const r of (ss ?? []) as any[]) {
          const code = String(r.location).toUpperCase();
          const p = prodById.get(r.inventory_id);
          (slotProducts[code] ??= new Set()).add(String(r.inventory_id));
          counts[code] = slotProducts[code].size;
          contents.push({
            inventory_id: String(r.inventory_id),
            location: code,
            name: p?.name ?? null,
            name_ar: p?.name_ar ?? null,
            sku: p?.sku ?? null,
            barcode: p?.barcode ?? null,
            image: p?.image ?? null,
            quantity: r.quantity ?? 0,
            total: p?.total ?? 0,
          });
        }
        if (!ss || ss.length < PAGE) break;
      }

      // Variants placed on shelves (the product "options"). These live in
      // variant_shelf_stock and were previously invisible on the shelf map.
      const hasVarShelf = !(await supabase.from("variant_shelf_stock").select("variant_id").limit(1)).error;
      if (hasVarShelf) {
        // Collect variant placements, then resolve variant + parent product.
        const vsRows: { variant_id: string; location: string; quantity: number }[] = [];
        for (let from = 0; ; from += PAGE) {
          const { data: vs, error } = await supabase
            .from("variant_shelf_stock")
            .select("variant_id, location, quantity")
            .range(from, from + PAGE - 1);
          if (error) break;
          for (const r of (vs ?? []) as any[]) vsRows.push({ variant_id: String(r.variant_id), location: String(r.location), quantity: r.quantity ?? 0 });
          if (!vs || vs.length < PAGE) break;
        }
        if (vsRows.length) {
          const vIds = Array.from(new Set(vsRows.map((r) => r.variant_id)));
          // Resolve variants, then their parent products separately (no reliance
          // on a nested FK embed, which can vary by relationship name).
          const varById = new Map<string, any>();
          for (let i = 0; i < vIds.length; i += 200) {
            const { data: vs } = await supabase
              .from("product_variants")
              .select("id, variant_name, barcode, sku, stock_quantity, parent_product_id")
              .in("id", vIds.slice(i, i + 200));
            for (const v of (vs ?? []) as any[]) varById.set(String(v.id), v);
          }
          const pIds = Array.from(new Set(Array.from(varById.values()).map((v) => String(v.parent_product_id)).filter(Boolean)));
          const parentById = new Map<string, any>();
          for (let i = 0; i < pIds.length; i += 200) {
            const { data: ps } = await supabase
              .from("products")
              .select("id, name_en, name_ar, sku, image_url")
              .in("id", pIds.slice(i, i + 200));
            for (const pr of (ps ?? []) as any[]) parentById.set(String(pr.id), pr);
          }
          for (const r of vsRows) {
            const v = varById.get(r.variant_id);
            const parent = v ? parentById.get(String(v.parent_product_id)) : null;
            const code = r.location.toUpperCase();
            (slotProducts[code] ??= new Set()).add(`v:${r.variant_id}`);
            counts[code] = slotProducts[code].size;
            contents.push({
              inventory_id: `v:${r.variant_id}`,
              location: code,
              name: parent?.name_en ?? parent?.name_ar ?? v?.variant_name ?? null,
              name_ar: parent?.name_ar ?? null,
              sku: v?.sku ?? parent?.sku ?? null,
              barcode: v?.barcode ?? null,
              image: parent?.image_url ?? null,
              variant: v?.variant_name ?? null,
              isVariant: true,
              quantity: r.quantity ?? 0,
              total: v?.stock_quantity ?? 0,
            });
          }
        }
      }
    } else {
      for (let from = 0; ; from += PAGE) {
        const { data: inv, error } = await supabase
          .from("inventory")
          .select("id, stock_quantity, location, products(name_en, name_ar, sku, barcode, image_url)")
          .not("location", "is", null)
          .range(from, from + PAGE - 1);
        if (error) break;
        for (const r of (inv ?? []) as any[]) {
          const code = String(r.location).toUpperCase();
          (slotProducts[code] ??= new Set()).add(String(r.id));
          counts[code] = slotProducts[code].size;
          contents.push({
            inventory_id: String(r.id),
            location: code,
            name: r.products?.name_en ?? r.products?.name_ar ?? null,
            name_ar: r.products?.name_ar ?? null,
            sku: r.products?.sku ?? null,
            barcode: r.products?.barcode ?? null,
            image: r.products?.image_url ?? null,
            quantity: r.stock_quantity ?? 0,
            total: r.stock_quantity ?? 0,
          });
        }
        if (!inv || inv.length < PAGE) break;
      }
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
            Run <code className="rounded-sm bg-white px-1">supabase/shelf_locations.sql</code> once in your
            Supabase SQL editor to add the <code>location</code> column and the <code>shelf_slots</code> table,
            then refresh this page.
          </p>
        </div>
      ) : (
        <>
          <ShelvesManager slots={slots} counts={counts} />
          <ShelfContents items={contents} slotCodes={slots.map((s) => s.code)} />
        </>
      )}
    </div>
  );
}
