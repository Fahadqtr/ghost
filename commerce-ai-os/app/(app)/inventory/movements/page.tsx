import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import MovementForm, { type PickItem } from "@/components/MovementForm";

export const dynamic = "force-dynamic";

type Movement = {
  id: number | string;
  created_at: string | null;
  action_type: string | null;
  sku: string | null;
  old_value: string | null;
  new_value: string | null;
  details: any;
};

function fmtDateTime(s: string | null): string {
  if (!s) return "—";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-GB", { day: "2-digit", month: "short", year: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export default async function MovementsPage() {
  const supabase = createClient();

  // Product picker (inventory + product names). Page through the 1000 cap.
  const items: PickItem[] = [];
  const nameBySku = new Map<string, string>();
  // product_id -> parent inventory row, for attaching variant pick-items.
  const parentByProduct = new Map<string, { inventoryId: string; name: string | null; image_url: string | null }>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("inventory")
      .select("id, stock_quantity, product_id, products(sku, name_en, name_ar, barcode, image_url)")
      .range(from, from + PAGE - 1);
    if (error) break;
    for (const r of (data ?? []) as any[]) {
      const sku = r.products?.sku ?? null;
      const name = r.products?.name_en ?? r.products?.name_ar ?? null;
      if (sku && name) nameBySku.set(sku, name);
      if (r.product_id) parentByProduct.set(r.product_id, { inventoryId: r.id, name, image_url: r.products?.image_url ?? null });
      items.push({
        inventoryId: r.id,
        sku,
        name,
        name_ar: r.products?.name_ar ?? null,
        barcode: r.products?.barcode ?? null,
        image_url: r.products?.image_url ?? null,
        stock: r.stock_quantity ?? 0,
      });
    }
    if (!data || data.length < PAGE) break;
  }

  // Variant pick-items — each option scannable by its own barcode. A movement on
  // a variant adjusts that option's stock (the parent total is re-derived). Loaded
  // without an FK embed; failures are non-fatal so product scanning still works.
  {
    const vrows: any[] = [];
    let vError = false;
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from("product_variants")
        .select("id, sku, barcode, variant_name, stock_quantity, parent_product_id")
        .not("barcode", "is", null)
        .neq("barcode", "")
        .range(from, from + PAGE - 1);
      if (error) { vError = true; break; }
      vrows.push(...((data ?? []) as any[]));
      if (!data || data.length < PAGE) break;
    }
    if (!vError) {
      for (const r of vrows) {
        const parent = r.parent_product_id ? parentByProduct.get(r.parent_product_id) : undefined;
        if (!parent) continue; // no parent inventory row — skip
        const variant = r.variant_name ?? null;
        items.push({
          inventoryId: parent.inventoryId,
          variantId: r.id,
          sku: r.sku ?? null,
          name: parent.name && variant ? `${parent.name} · ${variant}` : variant ?? parent.name,
          name_ar: null,
          barcode: r.barcode ?? null,
          image_url: parent.image_url ?? null,
          stock: r.stock_quantity ?? 0,
        });
      }
    }
  }
  items.sort((a, b) => (a.name ?? a.sku ?? "").localeCompare(b.name ?? b.sku ?? ""));

  // Movement ledger (from the audit table). Read with the service-role client:
  // rows are written service-side and malak_audit's RLS may hide them from the
  // user session. Fall back to the RLS client if the service key isn't set.
  let ledger = supabase;
  try {
    ledger = createAdminClient() as any;
  } catch {
    /* no service role configured — use the user client */
  }
  const { data: movData } = await ledger
    .from("malak_audit")
    .select("id, created_at, action_type, sku, old_value, new_value, details")
    .in("action_type", ["stock_in", "stock_out", "shelf_assign", "shelf_move", "shelf_remove"])
    .order("created_at", { ascending: false })
    .limit(300);
  const movements = (movData ?? []) as Movement[];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted">Record stock entering (IN) or leaving (OUT) the warehouse. Each movement updates the live stock and is logged below.</p>
        <Link href="/inventory" className="btn-ghost px-3 py-1 text-xs whitespace-nowrap">← Back to inventory</Link>
      </div>

      <MovementForm items={items} />

      <div className="card overflow-x-auto p-0">
        <div className="border-b border-slate-200 px-4 py-3 text-sm font-medium text-ink">
          سجل الحركات · Movement &amp; shelf history <span className="text-muted">({movements.length})</span>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase text-muted">
              <th className="px-4 py-3 font-medium">When</th>
              <th className="px-4 py-3 font-medium">Type</th>
              <th className="px-4 py-3 font-medium">Product</th>
              <th className="px-4 py-3 font-medium text-right">Qty</th>
              <th className="px-4 py-3 font-medium">Reason</th>
              <th className="px-4 py-3 font-medium text-right">Before → After</th>
              <th className="px-4 py-3 font-medium">Note</th>
            </tr>
          </thead>
          <tbody>
            {movements.length === 0 ? (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-400">No movements yet.</td></tr>
            ) : (
              movements.map((m) => {
                const isIn = m.action_type === "stock_in";
                const isOut = m.action_type === "stock_out";
                const isShelf = !isIn && !isOut;
                const qty = m.details?.quantity ?? "—";
                const reason = isShelf
                  ? m.action_type === "shelf_assign" ? "إسناد رفّ"
                    : m.action_type === "shelf_move" ? "نقل رفّ"
                    : "إزالة من رفّ"
                  : (m.details?.reason ?? "—");
                const note = m.details?.note ?? "";
                const name = (m.sku && nameBySku.get(m.sku)) || "—";
                const badge = isIn ? "bg-green-100 text-green-700"
                  : isOut ? "bg-orange-100 text-orange-700"
                  : m.action_type === "shelf_remove" ? "bg-red-100 text-red-700"
                  : "bg-blue-100 text-blue-700";
                const label = isIn ? "IN ↓" : isOut ? "OUT ↑" : "رفّ ▦";
                return (
                  <tr key={m.id} className="border-b border-slate-100 hover:bg-slate-50">
                    <td className="px-4 py-3 text-xs text-muted">{fmtDateTime(m.created_at)}</td>
                    <td className="px-4 py-3">
                      <span className={`badge ${badge}`}>{label}</span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-ink">{name}</div>
                      <div className="text-xs text-muted">{m.sku ?? "—"}</div>
                    </td>
                    <td className="px-4 py-3 text-right font-medium">
                      {isShelf ? (qty === "—" ? "—" : qty) : `${isIn ? "+" : "−"}${qty}`}
                    </td>
                    <td className="px-4 py-3 text-slate-600 capitalize">{reason}</td>
                    <td className="px-4 py-3 text-right text-slate-600">{m.old_value ?? "—"} → {m.new_value ?? "—"}</td>
                    <td className="px-4 py-3 text-slate-500">{note}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
