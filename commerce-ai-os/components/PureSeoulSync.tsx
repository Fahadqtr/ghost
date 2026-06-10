"use client";

import { useState } from "react";
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

          <Section
            title={`🆕 ناقصة مؤكّدة على Pure Seoul — ${c.missingOnPS} (ما لها أي شبيه على PS → أضفها)`}
            onExport={res.missingOnPS.length ? () => downloadCsv(
              "pure_seoul_missing_confident.csv",
              ["SKU", "Name EN", "Price (QAR)", "Category"],
              res.missingOnPS.map((p) => [p.sku, p.name_en, p.price as any, p.category])
            ) : undefined}
          >
            <List items={res.missingOnPS} render={(p) => <Row a={p.name_en} b={p.sku} c={p.price != null ? `${p.price} ر.ق` : ""} />} total={c.missingOnPS} />
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
            )} total={c.reviewOnPS} />
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
  const color = accent === "amber" ? "text-amber-700" : accent === "violet" ? "text-brand-dark" : "text-ink";
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
function List({ items, render, total }: { items: PSItem[]; render: (p: PSItem) => React.ReactNode; total: number }) {
  if (items.length === 0) return <p className="text-sm text-slate-400">لا شيء.</p>;
  return (
    <>
      <ul className="max-h-80 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200">
        {items.map((p, i) => <li key={i} className="px-3 py-2 text-sm">{render(p)}</li>)}
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
