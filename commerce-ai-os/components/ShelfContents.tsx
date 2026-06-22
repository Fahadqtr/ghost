"use client";

import { useMemo, useState } from "react";
import { shelfOf, compareSlot } from "@/lib/shelf";

export type ShelfItem = {
  location: string;
  name: string | null;
  name_ar: string | null;
  sku: string | null;
  barcode: string | null;
};

export default function ShelfContents({ items }: { items: ShelfItem[] }) {
  const [q, setQ] = useState("");

  // Filter, then group by shelf → slot.
  const groups = useMemo(() => {
    const n = q.trim().toLowerCase();
    const filtered = n
      ? items.filter(
          (it) =>
            (it.name ?? "").toLowerCase().includes(n) ||
            (it.sku ?? "").toLowerCase().includes(n) ||
            (it.barcode ?? "").toLowerCase().includes(n) ||
            it.location.toLowerCase().includes(n) ||
            (it.name_ar ?? "").includes(q.trim())
        )
      : items;

    const byShelf = new Map<string, Map<string, ShelfItem[]>>();
    for (const it of filtered) {
      const shelf = shelfOf(it.location) ?? "?";
      const slot = byShelf.get(shelf) ?? new Map<string, ShelfItem[]>();
      const arr = slot.get(it.location) ?? [];
      arr.push(it);
      slot.set(it.location, arr);
      byShelf.set(shelf, slot);
    }
    return Array.from(byShelf.entries())
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([shelf, slotMap]) => ({
        shelf,
        slots: Array.from(slotMap.entries())
          .sort((a, b) => compareSlot(a[0], b[0]))
          .map(([code, prods]) => ({
            code,
            prods: prods.sort((a, b) => (a.name ?? a.sku ?? "").localeCompare(b.name ?? b.sku ?? "")),
          })),
        total: Array.from(slotMap.values()).reduce((s, a) => s + a.length, 0),
      }));
  }, [items, q]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-ink">Shelf contents</h2>
        <div className="flex items-center gap-2">
          <input
            className="input w-56"
            placeholder="Search name / barcode / SKU / shelf…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <button className="btn-ghost px-3 py-1.5 text-xs print:hidden" onClick={() => window.print()}>
            🖨️ Print
          </button>
        </div>
      </div>

      {items.length === 0 ? (
        <div className="card py-10 text-center text-sm text-slate-400">
          No products assigned to a shelf yet — set a product&apos;s Location from the inventory table or while counting.
        </div>
      ) : groups.length === 0 ? (
        <div className="card py-10 text-center text-sm text-slate-400">No products match “{q}”.</div>
      ) : (
        <div className="space-y-3">
          {groups.map((g) => (
            <div key={g.shelf} className="card">
              <div className="mb-3 font-medium text-ink">
                Shelf {g.shelf} <span className="text-xs text-muted">· {g.total} products</span>
              </div>
              <div className="space-y-3">
                {g.slots.map((s) => (
                  <div key={s.code}>
                    <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">
                      {s.code} <span className="font-normal">· {s.prods.length}</span>
                    </div>
                    <div className="overflow-x-auto rounded-lg border border-slate-200">
                      <table className="w-full text-sm">
                        <thead className="bg-slate-50 text-left text-xs uppercase text-muted">
                          <tr>
                            <th className="px-3 py-2">Product</th>
                            <th className="px-3 py-2">SKU</th>
                            <th className="px-3 py-2">Barcode</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {s.prods.map((p, i) => (
                            <tr key={`${p.sku ?? p.barcode ?? i}`}>
                              <td className="px-3 py-2">
                                <div className="font-medium text-ink">{p.name ?? p.sku ?? "—"}</div>
                                {p.name_ar && <div className="text-xs text-muted">{p.name_ar}</div>}
                              </td>
                              <td className="px-3 py-2 text-slate-600">{p.sku ?? "—"}</td>
                              <td className="px-3 py-2 font-mono text-slate-600">{p.barcode ?? "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
