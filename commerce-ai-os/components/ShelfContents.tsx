"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { shelfOf, compareSlot } from "@/lib/shelf";
import { removeFromShelf, moveShelfStock } from "@/app/(app)/inventory/actions";

export type ShelfItem = {
  inventory_id: string;
  location: string;
  name: string | null;
  name_ar: string | null;
  sku: string | null;
  barcode: string | null;
  quantity: number; // units in THIS shelf
  total: number; // product's total stock (all shelves)
};

export default function ShelfContents({ items, slotCodes = [] }: { items: ShelfItem[]; slotCodes?: string[] }) {
  const [q, setQ] = useState("");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const allSlots = useMemo(() => {
    const set = new Set<string>(slotCodes.map((c) => c.toUpperCase()));
    for (const it of items) set.add(it.location.toUpperCase());
    return Array.from(set).sort(compareSlot);
  }, [slotCodes, items]);

  const runAction = (key: string, fn: () => Promise<{ error?: string } | { ok: true } | void>) => {
    setBusyKey(key);
    startTransition(async () => {
      const res = await fn();
      setBusyKey(null);
      if (res && "error" in res && res.error) {
        alert(res.error);
        return;
      }
      router.refresh();
    });
  };

  const onMove = (p: ShelfItem, to: string) => {
    if (!to || to === p.location) return;
    runAction(`${p.inventory_id}:${p.location}`, () => moveShelfStock(p.inventory_id, p.location, to));
  };
  const onRemove = (p: ShelfItem) => {
    if (!confirm(`شيل «${p.name ?? p.sku ?? "المنتج"}» من الرفّ ${p.location}؟`)) return;
    runAction(`${p.inventory_id}:${p.location}`, () => removeFromShelf(p.inventory_id, p.location));
  };

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
                      {s.code}{" "}
                      <span className="font-normal">
                        · {s.prods.length} products · {s.prods.reduce((a, p) => a + p.quantity, 0)} units
                      </span>
                    </div>
                    <div className="overflow-x-auto rounded-lg border border-slate-200">
                      <table className="w-full text-sm">
                        <thead className="bg-slate-50 text-left text-xs uppercase text-muted">
                          <tr>
                            <th className="px-3 py-2">Product</th>
                            <th className="hidden px-3 py-2 sm:table-cell">SKU</th>
                            <th className="hidden px-3 py-2 sm:table-cell">Barcode</th>
                            <th className="px-3 py-2 text-right">Here</th>
                            <th className="px-3 py-2 text-right">Total</th>
                            <th className="px-3 py-2 text-right print:hidden">إجراءات</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {s.prods.map((p, i) => (
                            <tr key={`${p.sku ?? p.barcode ?? i}`}>
                              <td className="px-3 py-2">
                                <div className="font-medium text-ink">{p.name ?? p.sku ?? "—"}</div>
                                {p.name_ar && <div className="text-xs text-muted">{p.name_ar}</div>}
                              </td>
                              <td className="hidden px-3 py-2 text-slate-600 sm:table-cell">{p.sku ?? "—"}</td>
                              <td className="hidden px-3 py-2 font-mono text-slate-600 sm:table-cell">{p.barcode ?? "—"}</td>
                              <td className="px-3 py-2 text-right font-semibold text-ink">{p.quantity}</td>
                              <td className="px-3 py-2 text-right text-slate-500">{p.total}</td>
                              <td className="px-3 py-2 text-right print:hidden">
                                <div className="flex items-center justify-end gap-1.5">
                                  <select
                                    className="input h-7 w-auto py-0 text-xs"
                                    value={p.location}
                                    disabled={pending && busyKey === `${p.inventory_id}:${p.location}`}
                                    onChange={(e) => onMove(p, e.target.value)}
                                    title="نقل لرفّ آخر"
                                  >
                                    {!allSlots.includes(p.location) && <option value={p.location}>{p.location}</option>}
                                    {allSlots.map((c) => (
                                      <option key={c} value={c}>
                                        {c}
                                      </option>
                                    ))}
                                  </select>
                                  <button
                                    className="rounded px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
                                    disabled={pending && busyKey === `${p.inventory_id}:${p.location}`}
                                    onClick={() => onRemove(p)}
                                    title="شيل من الرفّ"
                                  >
                                    ✕ شيل
                                  </button>
                                </div>
                              </td>
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
