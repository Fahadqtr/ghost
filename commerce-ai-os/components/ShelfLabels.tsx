"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import JsBarcode from "jsbarcode";
import { shelfOf, compareSlot } from "@/lib/shelf";

export type LabelItem = {
  id: string; // unique per label (inventory_id or variant_id) — for stable keys/picks
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
    const svg = ref.current;
    if (!svg) return;
    while (svg.firstChild) svg.removeChild(svg.firstChild); // never leave a stale barcode
    if (!value) return;
    try {
      JsBarcode(svg, value, { format: "CODE128", width: 1.4, height, displayValue: false, margin: 0 });
    } catch {
      /* invalid value → leave cleared */
    }
  }, [value, height]);
  return <svg ref={ref} className="h-auto w-full" />;
}

// Stable identity for a single label (a product/variant at one slot).
const keyOf = (it: LabelItem) => `${it.id}|${it.location.toUpperCase()}`;

export default function ShelfLabels({ items }: { items: LabelItem[] }) {
  const [shelf, setShelf] = useState("");
  const [slot, setSlot] = useState(""); // a specific rack within the shelf (e.g. A2)
  const [cols, setCols] = useState(3);
  const [q, setQ] = useState(""); // search to find products to pick
  const [picks, setPicks] = useState<Set<string>>(new Set()); // chosen labels
  const [pickedOnly, setPickedOnly] = useState(false); // show only the chosen ones
  const togglePick = (k: string) =>
    setPicks((s) => {
      const n = new Set(s);
      n.has(k) ? n.delete(k) : n.add(k);
      return n;
    });

  const shelves = useMemo(() => {
    const set = new Set<string>();
    for (const it of items) { const s = shelfOf(it.location); if (s) set.add(s); }
    return Array.from(set).sort();
  }, [items]);

  // Slots (racks) available — narrowed to the chosen shelf when one is selected.
  const slots = useMemo(() => {
    const set = new Set<string>();
    for (const it of items) {
      const loc = it.location.toUpperCase();
      if (!shelf || shelfOf(loc) === shelf) set.add(loc);
    }
    return Array.from(set).sort(compareSlot);
  }, [items, shelf]);

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let picked = slot
      ? items.filter((it) => it.location.toUpperCase() === slot)
      : shelf
        ? items.filter((it) => shelfOf(it.location) === shelf)
        : items;
    if (pickedOnly) picked = picked.filter((it) => picks.has(keyOf(it)));
    if (needle)
      picked = picked.filter(
        (it) =>
          (it.name ?? "").toLowerCase().includes(needle) ||
          (it.name_ar ?? "").includes(q.trim()) ||
          (it.sku ?? "").toLowerCase().includes(needle) ||
          (it.barcode ?? "").toLowerCase().includes(needle)
      );
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
  }, [items, shelf, slot, q, pickedOnly, picks]);

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
          <select
            className="input w-auto"
            value={shelf}
            onChange={(e) => { setShelf(e.target.value); setSlot(""); }}
          >
            <option value="">All shelves</option>
            {shelves.map((s) => <option key={s} value={s}>Shelf {s}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2">
          Slot
          <select className="input w-auto" value={slot} onChange={(e) => setSlot(e.target.value)}>
            <option value="">All slots</option>
            {slots.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2">
          Columns
          <select className="input w-auto" value={cols} onChange={(e) => setCols(Number(e.target.value))}>
            {[2, 3, 4, 5, 6, 7, 8].map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <input
          className="input w-auto sm:max-w-[14rem]"
          placeholder="Search name / SKU / barcode…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={pickedOnly}
            onChange={(e) => setPickedOnly(e.target.checked)}
          />
          المحدّد فقط · Selected only
          {picks.size > 0 && <span className="text-muted">({picks.size})</span>}
        </label>
        {picks.size > 0 && (
          <button
            type="button"
            className="text-xs text-blue-600 hover:underline"
            onClick={() => { setPicks(new Set()); setPickedOnly(false); }}
          >
            مسح التحديد
          </button>
        )}
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
                  const k = keyOf(p);
                  return (
                    <div
                      key={`${k}|${i}`}
                      className={`label-cell relative flex flex-col items-center gap-0.5 rounded-lg border bg-white text-center ${picks.has(k) ? "border-blue-500 ring-1 ring-blue-300" : "border-slate-300"} ${compact ? "p-1" : "p-2"}`}
                    >
                      <input
                        type="checkbox"
                        className="absolute left-1 top-1 print:hidden"
                        checked={picks.has(k)}
                        onChange={() => togglePick(k)}
                        aria-label="Pick this label"
                      />
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
