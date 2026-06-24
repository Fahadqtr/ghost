"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import JsBarcode from "jsbarcode";
import { shelfOf, compareSlot } from "@/lib/shelf";

export type LabelItem = {
  location: string;
  name: string | null;
  name_ar: string | null;
  sku: string | null;
  barcode: string | null;
  image_url: string | null;
  quantity: number; // units in this shelf
  total: number; // product's total stock
};

function Barcode({ value, height }: { value: string; height: number }) {
  const ref = useRef<SVGSVGElement>(null);
  useEffect(() => {
    if (ref.current && value) {
      try {
        JsBarcode(ref.current, value, { format: "CODE128", width: 1.4, height, displayValue: false, margin: 0 });
      } catch {
        /* ignore invalid values */
      }
    }
  }, [value, height]);
  return <svg ref={ref} className="h-auto w-full" />;
}

export default function ShelfLabels({ items }: { items: LabelItem[] }) {
  const [shelf, setShelf] = useState("");
  const [cols, setCols] = useState(3);

  const shelves = useMemo(() => {
    const set = new Set<string>();
    for (const it of items) { const s = shelfOf(it.location); if (s) set.add(s); }
    return Array.from(set).sort();
  }, [items]);

  const groups = useMemo(() => {
    const picked = shelf ? items.filter((it) => shelfOf(it.location) === shelf) : items;
    const byShelf = new Map<string, LabelItem[]>();
    for (const it of picked) {
      const s = shelfOf(it.location) ?? "?";
      const arr = byShelf.get(s) ?? [];
      arr.push(it);
      byShelf.set(s, arr);
    }
    return Array.from(byShelf.entries())
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([s, arr]) => ({
        shelf: s,
        items: arr.sort(
          (a, b) => compareSlot(a.location, b.location) || (a.name ?? "").localeCompare(b.name ?? "")
        ),
      }));
  }, [items, shelf]);

  return (
    <div className="space-y-4">
      <style>{`
        @media print {
          /* print ONLY the label sheet — hide app header, bottom nav, controls */
          body * { visibility: hidden !important; }
          #shelf-sheet, #shelf-sheet * { visibility: visible !important; }
          #shelf-sheet { position: absolute; left: 0; top: 0; width: 100%; }
          @page { margin: 10mm; }
          .shelf-section { break-before: page; }
          .shelf-section:first-child { break-before: auto; }
          .label-cell { break-inside: avoid; }
        }
      `}</style>

      {/* Controls */}
      <div className="card flex flex-wrap items-center gap-4 text-sm print:hidden">
        <label className="flex items-center gap-2">
          Shelf
          <select className="input w-auto" value={shelf} onChange={(e) => setShelf(e.target.value)}>
            <option value="">All shelves</option>
            {shelves.map((s) => <option key={s} value={s}>Shelf {s}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2">
          Columns
          <select className="input w-auto" value={cols} onChange={(e) => setCols(Number(e.target.value))}>
            {[2, 3, 4, 5, 6, 7, 8].map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <span className="text-muted sm:ml-auto">
          {groups.reduce((s, g) => s + g.items.length, 0)} labels
        </span>
        <button
          className="btn-primary px-4 py-1.5 text-xs disabled:opacity-50"
          disabled={items.length === 0}
          onClick={() => window.print()}
        >
          🖨️ Print / Save as PDF
        </button>
      </div>

      {items.length === 0 ? (
        <div className="card py-10 text-center text-sm text-slate-400 print:hidden">
          No products assigned to a shelf yet.
        </div>
      ) : (
        <div id="shelf-sheet" className="space-y-6">
          {groups.map((g) => (
            <section key={g.shelf} className="shelf-section space-y-3">
              <h2 className="text-lg font-bold text-ink">Shelf {g.shelf}</h2>
              <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
                {g.items.map((p, i) => {
                  const compact = cols >= 5;
                  return (
                    <div
                      key={`${p.sku ?? p.barcode ?? i}`}
                      className={`label-cell flex flex-col items-center gap-0.5 rounded-lg border border-slate-300 bg-white text-center ${compact ? "p-1" : "p-2"}`}
                    >
                      <div className="flex w-full items-center justify-between">
                        <span className="rounded bg-slate-900 px-1 py-0.5 font-mono text-[10px] font-bold text-white">
                          {p.location}
                        </span>
                        <span className="rounded bg-blue-600 px-1 py-0.5 text-[10px] font-bold text-white">
                          ×{p.quantity}
                        </span>
                      </div>
                      <div className={`flex w-full items-center justify-center overflow-hidden ${compact ? "h-12" : "h-20"}`}>
                        {p.image_url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={p.image_url} alt="" className="max-h-full max-w-full object-contain" />
                        ) : (
                          <div className={compact ? "text-xl" : "text-3xl"}>📦</div>
                        )}
                      </div>
                      <div className={`line-clamp-2 font-semibold leading-tight text-ink ${compact ? "text-[9px]" : "text-xs"}`}>
                        {p.name ?? p.sku}
                      </div>
                      {p.sku ? (
                        <div className={`font-mono text-slate-500 ${compact ? "text-[8px]" : "text-[10px]"}`}>
                          {p.sku}
                        </div>
                      ) : null}
                      {p.barcode ? (
                        <>
                          <Barcode value={p.barcode} height={compact ? 28 : 44} />
                          <div className={`font-mono tracking-wider text-slate-700 ${compact ? "text-[8px]" : "text-[11px]"}`}>
                            {p.barcode}
                          </div>
                        </>
                      ) : (
                        <div className="text-[9px] text-slate-400">no barcode</div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
