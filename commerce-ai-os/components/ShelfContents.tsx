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
  image?: string | null;       // product thumbnail
  variant?: string | null;     // option name (for variant placements)
  isVariant?: boolean;         // a product OPTION, not the parent product
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
                    {/* Card list — readable on mobile (no horizontal scroll, no
                        one-word-per-line wrapping like the old table). */}
                    <div className="space-y-1.5">
                      {s.prods.map((p, i) => {
                        const busy = pending && busyKey === `${p.inventory_id}:${p.location}`;
                        return (
                          <div key={`${p.inventory_id}|${p.sku ?? p.barcode ?? i}`} className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white p-2.5">
                            {/* thumbnail */}
                            <div className="h-12 w-12 shrink-0 overflow-hidden rounded-md border border-slate-200 bg-slate-50">
                              {p.image ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img src={p.image} alt={p.name ?? ""} className="h-full w-full object-cover" />
                              ) : (
                                <div className="flex h-full w-full items-center justify-center text-slate-300">📦</div>
                              )}
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="line-clamp-2 text-sm font-medium leading-snug text-ink">{p.name ?? p.sku ?? "—"}</div>
                              {p.isVariant && p.variant ? (
                                <div className="mt-0.5 inline-block rounded-sm bg-violet-50 px-1.5 py-0.5 text-[11px] font-medium text-violet-700">خيار: {p.variant}</div>
                              ) : p.name_ar ? (
                                <div className="line-clamp-1 text-xs text-muted">{p.name_ar}</div>
                              ) : null}
                              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted">
                                <span className="rounded-sm bg-slate-100 px-1.5 py-0.5 font-medium text-ink">هنا {p.quantity}</span>
                                <span>إجمالي {p.total}</span>
                                {p.sku && <span className="font-mono">{p.sku}</span>}
                              </div>
                            </div>
                            {/* edit controls — product placements only (variant moves use the variant editor) */}
                            {p.isVariant ? null : (
                              <div className="flex shrink-0 flex-col items-stretch gap-1 print:hidden">
                                <select
                                  className="input h-8 w-[72px] py-0 text-xs"
                                  value={p.location}
                                  disabled={busy}
                                  onChange={(e) => onMove(p, e.target.value)}
                                  title="نقل لرفّ آخر"
                                >
                                  {!allSlots.includes(p.location) && <option value={p.location}>{p.location}</option>}
                                  {allSlots.map((c) => (
                                    <option key={c} value={c}>{c}</option>
                                  ))}
                                </select>
                                <button
                                  className="rounded-md border border-red-200 px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
                                  disabled={busy}
                                  onClick={() => onRemove(p)}
                                  title="شيل من الرفّ"
                                >
                                  ✕ شيل
                                </button>
                              </div>
                            )}
                          </div>
                        );
                      })}
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
