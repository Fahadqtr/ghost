"use client";

import { useState, useEffect } from "react";
import * as XLSX from "xlsx";
import { comparePureSeoul, type PSCompare, type PSItem } from "@/app/(app)/import-export/pure-seoul-actions";

// CSV download helper (client-side blob).
function downloadCsv(name: string, headers: string[], rows: (string | number | null | undefined)[][]) {
  const cell = (v: any) => { const s = v == null ? "" : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const csv = "﻿" + [headers, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a"); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url);
}

export default function PureSeoulSync() {
  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [res, setRes] = useState<PSCompare | null>(null);
  // SKUs selected to publish to Pure Seoul (the "approve" step).
  const [pub, setPub] = useState<Set<string>>(new Set());
  useEffect(() => {
    // Default: select all confident-missing (most likely to publish).
    if (res?.ok) setPub(new Set(res.missingOnPS.map((p) => p.sku).filter(Boolean) as string[]));
    else setPub(new Set());
  }, [res]);
  const togglePub = (sku: string | null) => {
    if (!sku) return;
    setPub((s) => { const n = new Set(s); n.has(sku) ? n.delete(sku) : n.add(sku); return n; });
  };
  const exportPublish = () => {
    if (!res) return;
    const chosen = [...res.missingOnPS, ...res.reviewOnPS].filter((p) => p.sku && pub.has(p.sku));
    downloadCsv(
      "pure_seoul_PUBLISH_list.csv",
      ["SKU", "Name EN", "Price (QAR)", "Category"],
      chosen.map((p) => [p.sku, p.name_en, p.price as any, p.category ?? ""])
    );
  };

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    setError(null); setRes(null);
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setBusy(true);
    try {
      const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
      const sheet = wb.SheetNames.includes("NonFoodProducts") ? "NonFoodProducts" : wb.SheetNames[0];
      const raw: Record<string, unknown>[] = XLSX.utils.sheet_to_json(wb.Sheets[sheet], { defval: "" });
      if (!raw.length) { setError(`الورقة "${sheet}" فاضية.`); setBusy(false); return; }

      // Detect columns — supports BOTH Pure Seoul export formats:
      //  • NonFoodProducts: id, global_id, name_en, price, approval, …branchStatus
      //  • AllExportData:   SPI(UniqueIdentifier), Product Name (En)(…), Price Global(Update), Availability for …
      const headers = Object.keys(raw[0]);
      const low = (h: string) => h.toLowerCase();
      const pick = (exact: string[], test?: (h: string) => boolean) =>
        headers.find((h) => exact.includes(low(h))) || (test ? headers.find((h) => test(low(h))) : undefined);
      const idKey = pick(["id"], (h) => h.includes("spi") || h.includes("uniqueidentifier"));
      const gidKey = pick(["global_id"]);
      const nameEnKey = pick(["name_en"], (h) => /product name \(en\)/.test(h));
      const nameArKey = pick(["name_ar"], (h) => /product name \(ar\)/.test(h));
      const priceKey = pick(["price"], (h) => h.includes("price"));
      const approvalKey = pick(["approval"]);
      const bsKey = headers.find((h) => low(h).endsWith("branchstatus")) || headers.find((h) => low(h).startsWith("availability"));
      // "Stock for [branch]" / "stock" / "quantity" → out-of-stock detection.
      const stockKey = headers.find((h) => low(h).startsWith("stock"))
        || headers.find((h) => low(h).includes("stock") || low(h) === "quantity" || low(h) === "qty");

      if (!nameEnKey && !idKey && !gidKey) {
        setError(`ما عرفت أعمدة الملف. الأعمدة: ${headers.slice(0, 8).join(", ")}…`);
        setBusy(false); return;
      }

      const rows = raw.map((r: any) => {
        const bsRaw = bsKey ? String(r[bsKey] ?? "").trim().toLowerCase() : "";
        const branchStatus = bsRaw === "false" || bsRaw === "inactive" ? "inactive"
          : bsRaw === "true" || bsRaw === "active" ? "active" : "";
        return {
          id: idKey ? String(r[idKey] ?? "") : "",
          global_id: gidKey ? String(r[gidKey] ?? "") : "",
          name_en: nameEnKey ? String(r[nameEnKey] ?? "") : "",
          name_ar: nameArKey ? String(r[nameArKey] ?? "") : "",
          price: priceKey ? String(r[priceKey] ?? "") : "",
          approval: approvalKey ? String(r[approvalKey] ?? "") : "",
          branchStatus,
          stock: stockKey ? String(r[stockKey] ?? "") : "",
        };
      });
      const out = await comparePureSeoul(rows);
      if (!out.ok) setError(out.error ?? "فشلت المقارنة.");
      setRes(out);
    } catch (err) {
      setError(err instanceof Error ? err.message : "تعذّرت قراءة الملف.");
    } finally {
      setBusy(false);
    }
  }

  const c = res?.counts;

  return (
    <div className="space-y-4">
      <div className="card space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-ink">رفع تصدير Pure Seoul</h3>
          <p className="text-xs text-muted">
            الأساس = مليكاس (كتالوجك). نقارن ملف Pure Seoul ونعرض وش لازم تعدّل فيه عشان يطابق مليكاس.
            يطابق بـ <code>global_id</code> ثم بالاسم. قراءة فقط.
          </p>
        </div>
        <input type="file" accept=".xlsx,.xls" onChange={onFile} disabled={busy} className="block text-sm" />
        {fileName ? <p className="text-xs text-muted">{fileName}{busy ? " · جاري التحليل…" : ""}</p> : null}
        {error ? <pre className="whitespace-pre-wrap rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</pre> : null}
      </div>

      {res?.ok && c ? (
        <>
          {/* Publish bar: the curated list to push to Pure Seoul on Snoonu. */}
          <div className="card flex flex-col gap-2 border-emerald-200 bg-emerald-50/60 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h3 className="text-sm font-semibold text-ink">قائمة النشر لـ Pure Seoul</h3>
              <p className="text-xs text-muted">المحدّد أدناه ({pub.size} منتج) = اللي بتنشره على Pure Seoul. صدّره وارفعه لسنونو.</p>
            </div>
            <button onClick={exportPublish} disabled={pub.size === 0} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">
              ⬇ تصدير قائمة النشر ({pub.size})
            </button>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="صفوف Pure Seoul" value={c.psRows} />
            <Stat label="متطابق مع مليكاس" value={c.matched} />
            <Stat label="ناقص مؤكّد (يضاف)" value={c.missingOnPS} accent="amber" />
            <Stat label="أسعار مختلفة" value={c.priceDiffs} accent="violet" />
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="يحتاج مراجعة" value={c.reviewOnPS} accent="slate" />
            <Stat label="زائد على PS" value={c.extraOnPS} accent="slate" />
            <Stat label="مرفوض على PS" value={c.psRejected} accent="slate" />
            <Stat label="مخفي على PS (inactive)" value={c.psInactive} accent="slate" />
          </div>

          {/* Stock view — موجودة (متوفّرة) vs مخلّصة (نافدة). */}
          {res.hasStock ? (
            <>
              <div className="grid grid-cols-2 gap-3">
                <Stat label="موجودة ومتوفّرة على PS" value={c.psInStock} accent="emerald" />
                <Stat label="مخلّصة (نافدة) على PS" value={c.psOutOfStock} accent="amber" />
              </div>
              <Section
                title={`🚫 مخلّصة (نافدة) على Pure Seoul — ${c.psOutOfStock} (المخزون صفر)`}
                onExport={res.psOutOfStock.length ? () => downloadCsv(
                  "pure_seoul_out_of_stock.csv",
                  ["SKU", "Name EN", "Pure Seoul price", "Stock"],
                  res.psOutOfStock.map((p) => [p.sku, p.name_en, p.psPrice, p.psStock as any])
                ) : undefined}
              >
                <List items={res.psOutOfStock} render={(p) => <Row a={p.name_en} b={p.sku} c={`مخزون ${p.psStock ?? 0}`} />} total={c.psOutOfStock} />
              </Section>
            </>
          ) : (
            <div className="card border-amber-200 bg-amber-50 text-xs text-amber-800">
              ملف Pure Seoul هذا ما فيه عمود مخزون (Stock for…)، فما أقدر أحدّد المخلّصة. ارفع تصدير «AllExportData» اللي فيه عمود المخزون والتوفّر.
            </div>
          )}

          <Section
            title={`🆕 ناقصة مؤكّدة على Pure Seoul — ${c.missingOnPS} (ما لها أي شبيه على PS → أضفها)`}
            onExport={res.missingOnPS.length ? () => downloadCsv(
              "pure_seoul_missing_confident.csv",
              ["SKU", "Name EN", "Price (QAR)", "Category"],
              res.missingOnPS.map((p) => [p.sku, p.name_en, p.price as any, p.category])
            ) : undefined}
          >
            <List items={res.missingOnPS} render={(p) => <Row a={p.name_en} b={p.sku} c={p.price != null ? `${p.price} ر.ق` : ""} />} total={c.missingOnPS} sel={pub} onToggle={togglePub} />
          </Section>

          <Section
            title={`🔍 يحتاج مراجعة — ${c.reviewOnPS} (شبيه موجود على PS باسم/مقاس مختلف)`}
            onExport={res.reviewOnPS.length ? () => downloadCsv(
              "pure_seoul_review.csv",
              ["SKU", "Malika name", "Closest Pure Seoul name", "Match %"],
              res.reviewOnPS.map((p) => [p.sku, p.name_en, p.psName, p.score != null ? Math.round(p.score * 100) : ""])
            ) : undefined}
          >
            <List items={res.reviewOnPS} render={(p) => (
              <div className="space-y-0.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 flex-1 truncate text-ink">{p.name_en ?? "—"}</span>
                  <span className="shrink-0 font-mono text-[10px] text-muted">{p.sku} · {p.score != null ? Math.round(p.score * 100) + "%" : ""}</span>
                </div>
                <p className="truncate text-[11px] text-amber-700">≈ PS: {p.psName}</p>
              </div>
            )} total={c.reviewOnPS} sel={pub} onToggle={togglePub} />
          </Section>

          <Section
            title={`💰 أسعار مختلفة — ${c.priceDiffs} (السعر الصح من مليكاس)`}
            onExport={res.priceDiffs.length ? () => downloadCsv(
              "pure_seoul_price_fixes.csv",
              ["SKU", "Name EN", "Pure Seoul price", "Malika price (correct)"],
              res.priceDiffs.map((p) => [p.sku, p.name_en, p.psPrice, p.price as any])
            ) : undefined}
          >
            <List items={res.priceDiffs} render={(p) => <Row a={p.name_en} b={p.sku} c={`${p.psPrice} ← ${p.price}`} />} total={c.priceDiffs} />
          </Section>

          <Section
            title={`➕ زائدة على Pure Seoul — ${c.extraOnPS} (مب بمليكاس، راجعها)`}
            onExport={res.extraOnPS.length ? () => downloadCsv(
              "pure_seoul_extra.csv",
              ["Name EN", "Pure Seoul price"],
              res.extraOnPS.map((p) => [p.name_en, p.psPrice])
            ) : undefined}
          >
            <List items={res.extraOnPS} render={(p) => <Row a={p.name_en} b={null} c={p.psPrice ? `${p.psPrice} ر.ق` : ""} />} total={c.extraOnPS} />
          </Section>
        </>
      ) : null}
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: string }) {
  const color = accent === "amber" ? "text-amber-700" : accent === "violet" ? "text-brand-dark" : accent === "emerald" ? "text-emerald-700" : "text-ink";
  return <div className="card"><p className="text-xs text-muted">{label}</p><p className={`text-xl font-semibold ${color}`}>{value}</p></div>;
}
function Section({ title, children, onExport }: { title: string; children: React.ReactNode; onExport?: () => void }) {
  return (
    <div className="card">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        {onExport ? <button onClick={onExport} className="btn-ghost shrink-0 px-2 py-1 text-xs">⬇ CSV</button> : null}
      </div>
      {children}
    </div>
  );
}
function List({ items, render, total, sel, onToggle }: {
  items: PSItem[];
  render: (p: PSItem) => React.ReactNode;
  total: number;
  sel?: Set<string>;
  onToggle?: (sku: string | null) => void;
}) {
  if (items.length === 0) return <p className="text-sm text-slate-400">لا شيء.</p>;
  // When selection is enabled, offer a select-all / none toggle scoped to this list.
  const selectable = !!sel && !!onToggle;
  const skus = items.map((p) => p.sku).filter(Boolean) as string[];
  const allOn = selectable && skus.length > 0 && skus.every((s) => sel!.has(s));
  const toggleAll = () => { if (!onToggle) return; skus.forEach((s) => { if (allOn === sel!.has(s)) onToggle(s); }); };
  return (
    <>
      {selectable ? (
        <label className="mb-2 flex items-center gap-2 text-xs text-muted">
          <input type="checkbox" checked={allOn} onChange={toggleAll} className="h-3.5 w-3.5" />
          {allOn ? "إلغاء تحديد الكل" : "تحديد الكل للنشر"} ({skus.filter((s) => sel!.has(s)).length}/{skus.length})
        </label>
      ) : null}
      <ul className="max-h-80 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200">
        {items.map((p, i) => (
          <li key={i} className="flex items-center gap-2 px-3 py-2 text-sm">
            {selectable ? (
              <input
                type="checkbox"
                checked={!!p.sku && sel!.has(p.sku)}
                disabled={!p.sku}
                onChange={() => onToggle!(p.sku)}
                className="h-3.5 w-3.5 shrink-0"
                title={p.sku ? "اختر للنشر على Pure Seoul" : "بدون SKU"}
              />
            ) : null}
            <div className="min-w-0 flex-1">{render(p)}</div>
          </li>
        ))}
      </ul>
      {total > items.length ? <p className="mt-1 text-xs text-muted">…و {total - items.length} إضافية (نزّل CSV للكل).</p> : null}
    </>
  );
}
function Row({ a, b, c }: { a: string | null; b: string | null; c: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="min-w-0 flex-1 truncate text-ink">{a ?? "—"}</span>
      {c ? <span className="shrink-0 font-mono text-xs text-emerald-700">{c}</span> : null}
      {b ? <span className="shrink-0 font-mono text-xs text-muted">{b}</span> : null}
    </div>
  );
}
