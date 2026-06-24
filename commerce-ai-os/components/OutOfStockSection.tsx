"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { markOutOfStockByNames } from "@/app/(app)/inventory/actions";

export type OosItem = {
  id: string;
  name_en: string | null;
  name_ar: string | null;
  sku: string | null;
  barcode: string | null;
  image_url: string | null;
  category: string | null;
  updated_at: string | null;
};

function csvEscape(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export default function OutOfStockSection({ items }: { items: OosItem[] }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [paste, setPaste] = useState("");
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{
    matched: number;
    unmatched: string[];
    shopify?: { configured: boolean; pushed?: number; failed?: number; message?: string };
    error?: string;
  } | null>(null);

  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase();
    if (!n) return items;
    return items.filter(
      (p) =>
        (p.name_en ?? "").toLowerCase().includes(n) ||
        (p.name_ar ?? "").includes(q.trim()) ||
        (p.sku ?? "").toLowerCase().includes(n) ||
        (p.barcode ?? "").toLowerCase().includes(n)
    );
  }, [items, q]);

  function exportCsv() {
    const header = ["sku", "barcode", "name_en", "name_ar", "category", "stock", "updated_at"];
    const lines = [header.join(",")];
    for (const p of filtered) {
      lines.push(
        [p.sku, p.barcode, p.name_en, p.name_ar, p.category, 0, p.updated_at].map(csvEscape).join(",")
      );
    }
    const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `out-of-stock_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function markPasted() {
    if (!paste.trim()) return;
    setResult(null);
    startTransition(async () => {
      const res = await markOutOfStockByNames(paste);
      setResult(res);
      if (!res.error) {
        setPaste("");
        router.refresh();
      }
    });
  }

  return (
    <div className="space-y-4">
      <style>{`
        @media print {
          body * { visibility: hidden !important; }
          #oos-sheet, #oos-sheet * { visibility: visible !important; }
          #oos-sheet { position: absolute; left: 0; top: 0; width: 100%; }
          @page { margin: 10mm; }
          .oos-card { break-inside: avoid; }
        }
      `}</style>

      {/* Mark out of stock by pasted names */}
      <details className="card print:hidden">
        <summary className="cursor-pointer text-sm font-semibold text-ink">
          ➕ علّم منتجات نافدة بلصق أسمائها
        </summary>
        <p className="mt-2 text-xs text-muted">
          الصق أسماء المنتجات (سطر لكل منتج). يُصفّر المخزون (والخيارات)، ويضع الحالة «Out of Stock»، ويُلغي إدراج القنوات، ويدفع 0 لـShopify.
        </p>
        <textarea
          className="input mt-2 min-h-32 w-full font-mono text-xs"
          placeholder={"Product name one\nProduct name two\n…"}
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
        />
        <div className="mt-2 flex items-center gap-3">
          <button className="btn-primary px-4 py-1.5 text-xs disabled:opacity-50" disabled={pending || !paste.trim()} onClick={markPasted}>
            {pending ? "…يعلّم" : "علّم out of stock"}
          </button>
          {result && !result.error && (
            <span className="text-xs text-emerald-700">
              ✓ {result.matched} منتج عُلّم
              {result.shopify
                ? result.shopify.configured
                  ? ` · Shopify: ${result.shopify.pushed} دُفع${result.shopify.failed ? `، ${result.shopify.failed} فشل` : ""}`
                  : " · Shopify غير مفعّل"
                : ""}
              {result.unmatched.length ? ` · ${result.unmatched.length} غير مطابق` : ""}
            </span>
          )}
          {result?.error && <span className="text-xs text-red-600">{result.error}</span>}
        </div>
        {result && result.unmatched.length > 0 && (
          <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
            <div className="mb-1 font-medium">غير مطابق ({result.unmatched.length}) — راجع الإملاء:</div>
            <ul className="max-h-40 list-disc space-y-0.5 overflow-auto pr-4">
              {result.unmatched.map((u, i) => <li key={i}>{u}</li>)}
            </ul>
          </div>
        )}
      </details>

      {/* Toolbar */}
      <div className="card flex flex-wrap items-center gap-3 print:hidden">
        <input
          className="input w-full sm:max-w-xs"
          placeholder="Search name / SKU / barcode…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <span className="text-sm text-muted">{filtered.length} منتج نافد</span>
        <div className="flex gap-2 sm:ml-auto">
          <button className="btn-ghost px-4 py-1.5 text-xs disabled:opacity-50" disabled={filtered.length === 0} onClick={exportCsv}>
            ⬇️ Excel (CSV)
          </button>
          <button className="btn-primary px-4 py-1.5 text-xs disabled:opacity-50" disabled={filtered.length === 0} onClick={() => window.print()}>
            🖨️ PDF
          </button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="card py-10 text-center text-sm text-slate-400 print:hidden">ما في منتجات نافدة 🎉</div>
      ) : (
        <div id="oos-sheet" className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((p) => (
            <div key={p.id} className="oos-card flex items-center gap-3 rounded-lg border border-slate-200 bg-white p-2">
              <div className="flex h-16 w-16 flex-none items-center justify-center overflow-hidden rounded bg-slate-50">
                {p.image_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={p.image_url} alt="" className="max-h-full max-w-full object-contain" />
                ) : (
                  <span className="text-2xl">📦</span>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-ink">{p.name_en ?? p.sku ?? "—"}</div>
                {p.name_ar ? <div className="truncate text-xs text-muted" dir="rtl">{p.name_ar}</div> : null}
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-500">
                  {p.sku ? <span className="font-mono">{p.sku}</span> : null}
                  {p.category ? <span>· {p.category}</span> : null}
                  <span className="rounded bg-red-100 px-1.5 py-0.5 font-medium text-red-700">Out</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
