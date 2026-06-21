"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import JsBarcode from "jsbarcode";

export type LabelProduct = {
  sku: string | null;
  name: string | null;
  price: number | null;
  barcode: string;
};

type Entry = { product: LabelProduct; copies: number };

function Barcode({ value, height }: { value: string; height: number }) {
  const ref = useRef<SVGSVGElement>(null);
  useEffect(() => {
    if (ref.current && value) {
      try {
        JsBarcode(ref.current, value, {
          format: "CODE128",
          width: 1.4,
          height,
          displayValue: false,
          margin: 0,
        });
      } catch {
        /* ignore invalid values */
      }
    }
  }, [value, height]);
  return <svg ref={ref} className="h-auto w-full" />;
}

export default function BarcodeLabels({ products }: { products: LabelProduct[] }) {
  const [q, setQ] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [copies, setCopies] = useState("1");
  const [cols, setCols] = useState(3);
  const [showName, setShowName] = useState(true);
  const [showPrice, setShowPrice] = useState(true);
  const [showSku, setShowSku] = useState(true);

  const matches = useMemo(() => {
    const n = q.trim().toLowerCase();
    if (!n) return [];
    return products
      .filter(
        (p) =>
          (p.name ?? "").toLowerCase().includes(n) ||
          (p.sku ?? "").toLowerCase().includes(n) ||
          p.barcode.includes(q.trim())
      )
      .slice(0, 8);
  }, [q, products]);

  function add(p: LabelProduct) {
    const c = Math.max(1, Math.floor(Number(copies) || 1));
    setEntries((e) => {
      const i = e.findIndex((x) => x.product.barcode === p.barcode && x.product.sku === p.sku);
      if (i >= 0) {
        const n = [...e];
        n[i] = { ...n[i], copies: n[i].copies + c };
        return n;
      }
      return [...e, { product: p, copies: c }];
    });
    setQ("");
  }

  function setEntryCopies(idx: number, v: string) {
    const c = Math.max(1, Math.floor(Number(v) || 1));
    setEntries((e) => e.map((x, i) => (i === idx ? { ...x, copies: c } : x)));
  }
  function remove(idx: number) {
    setEntries((e) => e.filter((_, i) => i !== idx));
  }

  const labels = useMemo(
    () => entries.flatMap((e) => Array.from({ length: e.copies }, () => e.product)),
    [entries]
  );

  const barcodeHeight = cols >= 4 ? 30 : 40;

  return (
    <div className="space-y-4">
      {/* print-only styles: show just the label sheet */}
      <style>{`
        @media print {
          body * { visibility: hidden !important; }
          #label-sheet, #label-sheet * { visibility: visible !important; }
          #label-sheet { position: absolute; left: 0; top: 0; width: 100%; }
          @page { margin: 8mm; }
        }
      `}</style>

      {/* Controls */}
      <div className="card space-y-3 print:hidden">
        <div className="relative">
          <div className="flex gap-2">
            <input
              className="input flex-1"
              placeholder="Search product name / SKU / barcode to add…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <div className="flex flex-none items-center gap-1">
              <span className="text-xs text-muted">copies</span>
              <input
                className="input w-16"
                type="number"
                min={1}
                value={copies}
                onChange={(e) => setCopies(e.target.value)}
              />
            </div>
          </div>
          {matches.length > 0 && (
            <div className="absolute z-10 mt-1 w-full overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg">
              {matches.map((p) => (
                <button
                  key={`${p.sku}-${p.barcode}`}
                  className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-slate-50"
                  onClick={() => add(p)}
                >
                  <span className="min-w-0 truncate">{p.name ?? p.sku}</span>
                  <span className="flex-none text-xs text-muted">{p.sku} · {p.barcode}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-4 text-sm">
          <label className="flex items-center gap-2">
            Columns
            <select className="input w-auto" value={cols} onChange={(e) => setCols(Number(e.target.value))}>
              {[2, 3, 4, 5].map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={showName} onChange={(e) => setShowName(e.target.checked)} /> Name</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={showSku} onChange={(e) => setShowSku(e.target.checked)} /> SKU</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={showPrice} onChange={(e) => setShowPrice(e.target.checked)} /> Price</label>
          <span className="text-muted sm:ml-auto">{labels.length} label{labels.length === 1 ? "" : "s"}</span>
          <button
            className="btn-primary px-4 py-1.5 text-xs disabled:opacity-50"
            disabled={labels.length === 0}
            onClick={() => window.print()}
          >
            🖨️ Print
          </button>
        </div>

        {/* Selected list */}
        {entries.length > 0 && (
          <div className="divide-y divide-slate-100 rounded-lg border border-slate-200">
            {entries.map((e, i) => (
              <div key={`${e.product.sku}-${e.product.barcode}`} className="flex items-center gap-3 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate">{e.product.name ?? e.product.sku}</span>
                <span className="flex-none text-xs text-muted">{e.product.sku}</span>
                <input
                  className="input w-16 flex-none"
                  type="number"
                  min={1}
                  value={e.copies}
                  onChange={(ev) => setEntryCopies(i, ev.target.value)}
                />
                <button className="btn-ghost flex-none px-2 py-1 text-xs" onClick={() => remove(i)}>Remove</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Label sheet (also the print area) */}
      {labels.length === 0 ? (
        <div className="card py-10 text-center text-sm text-slate-400 print:hidden">
          No labels yet — search and add products above.
        </div>
      ) : (
        <div
          id="label-sheet"
          className="grid gap-2"
          style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
        >
          {labels.map((p, i) => (
            <div
              key={i}
              className="flex flex-col items-center gap-0.5 rounded border border-slate-200 bg-white p-2 text-center"
              style={{ breakInside: "avoid" }}
            >
              {showName && (
                <div className="line-clamp-2 text-[10px] font-medium leading-tight text-ink">{p.name ?? p.sku}</div>
              )}
              <Barcode value={p.barcode} height={barcodeHeight} />
              <div className="font-mono text-[10px] tracking-wide text-slate-700">{p.barcode}</div>
              <div className="flex w-full items-center justify-between px-1 text-[10px] text-slate-600">
                {showSku ? <span>{p.sku}</span> : <span />}
                {showPrice && p.price != null ? <span className="font-semibold">{p.price} QAR</span> : <span />}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
