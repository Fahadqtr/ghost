import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import OutOfStockSection, { type OosItem } from "@/components/OutOfStockSection";
import { isAvailable } from "@/lib/availability/read";
import { loadMasterScope } from "@/lib/home/master-scope.server";
import { scopeRows } from "@/lib/home/master-scope";

export const dynamic = "force-dynamic";

const PAGE = 1000;

export default async function OutOfStockPage() {
  const supabase = createClient();

  const items: OosItem[] = [];
  let errMsg: string | null = null;

  try {
    // INV.2F — "out of stock" is the EXPLICIT product availability
    // (products.stock_status), never derived from quantity. A product is listed
    // when it is not available (Out of Stock, or unset — treated conservatively
    // as not-available; never inferred from stock_quantity or variant sums).
    const rows: any[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from("products")
        .select("id, stock_status, name_en, name_ar, sku, image_url, main_category, barcode, updated_at")
        .range(from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      rows.push(...(data ?? []));
      if (!data || data.length < PAGE) break;
    }

    // CURRENT MASTER scope — same shared membership seam as the Inventory
    // Center and /v2 (never a second ECL query). This page lists TODAY'S
    // out-of-stock work, so products outside the active snoonu:malikas master
    // are not listed; their rows remain untouched in the database.
    //
    // Fails CLOSED: an unreadable membership throws to the error card below
    // rather than falling back to every product.
    const masterScope = await loadMasterScope();
    if (!masterScope.ok) {
      throw new Error(
        "تعذّر تحديد نطاق الكتالوج الحالي · couldn’t determine the current catalog scope",
      );
    }
    const scoped = scopeRows(rows, (r: any) => r?.id, masterScope);

    // Channels a product is still ACTIVE on — so we can flag "out of stock here
    // but still live on a channel" (e.g. Pure Seoul).
    const activeByProduct = new Map<string, string[]>();
    {
      const { data: chans } = await supabase.from("channels").select("id, name");
      const chanName = new Map<string, string>(((chans ?? []) as any[]).map((c) => [c.id, c.name]));
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from("channel_products")
          .select("product_id, channel_id, channel_status")
          .range(from, from + PAGE - 1);
        if (error) break;
        for (const r of (data ?? []) as any[]) {
          if ((r.channel_status ?? "") !== "Active") continue;
          const nm = chanName.get(r.channel_id);
          if (!nm) continue;
          const arr = activeByProduct.get(r.product_id) ?? [];
          if (!arr.includes(nm)) arr.push(nm);
          activeByProduct.set(r.product_id, arr);
        }
        if (!data || data.length < PAGE) break;
      }
    }

    for (const r of scoped as any[]) {
      if (isAvailable(r.stock_status)) continue; // only NOT-available products
      items.push({
        id: r.id,
        name_en: r.name_en ?? null,
        name_ar: r.name_ar ?? null,
        sku: r.sku ?? null,
        barcode: r.barcode ?? null,
        image_url: r.image_url ?? null,
        category: r.main_category ?? null,
        stock: 0, // availability-based surface — no quantity shown here
        activeChannels: (r.id && activeByProduct.get(r.id)) || [],
        updated_at: r.updated_at ?? null,
      });
    }
    items.sort((a, b) => (a.name_en ?? a.sku ?? "").localeCompare(b.name_en ?? b.sku ?? ""));
  } catch (e) {
    errMsg = e instanceof Error ? e.message : "Failed to load.";
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 print:hidden">
        <div>
          <h2 className="text-lg font-semibold text-ink">المنتجات النافدة · Out of stock</h2>
          <p className="text-sm text-muted">
            قائمة المنتجات اللي مخزونها صفر، مع صورة لكل منتج. صدّرها Excel أو PDF، أو علّم قائمة منتجات نافدة بلصق أسمائها.
          </p>
        </div>
        <Link href="/v2/inventory" className="btn-ghost px-3 py-1 text-xs whitespace-nowrap">← Back to inventory</Link>
      </div>

      {errMsg ? (
        <div className="card border-amber-200 bg-amber-50 text-sm text-amber-800">Couldn’t load: {errMsg}.</div>
      ) : (
        <OutOfStockSection items={items} />
      )}
    </div>
  );
}
