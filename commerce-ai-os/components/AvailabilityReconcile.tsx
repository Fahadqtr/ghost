"use client";

import { useState } from "react";
import * as XLSX from "xlsx";
import { cellToAvailable, type PlatformUpload, type ReconcileResult, type Avail } from "@/lib/availability-reconcile";
import {
  reconcileAvailabilityAction,
  applyReconciledAvailability,
  applyReconciledToShopify,
} from "@/app/(app)/import-export/availability-actions";

// Platforms the user uploads a list for. Shopify is the consolidation TARGET
// (pushed to at the end), not an uploaded source.
const SOURCES = [
  { key: "malika", label: "مليكاس", hint: "تصدير Snoonu (NonFoodProducts / AllExportData)" },
  { key: "pure_seoul", label: "Pure Seoul", hint: "تصدير Snoonu للوحة Pure Seoul" },
  { key: "talabat", label: "Talabat", hint: "إكسل فيه عمود مُفعّل/غير مُفعّل" },
  { key: "rafeeq", label: "Rafeeq", hint: "إكسل فيه عمود مُفعّل/غير مُفعّل" },
] as const;

const LABEL: Record<string, string> = Object.fromEntries(SOURCES.map((s) => [s.key, s.label]));

interface Parsed {
  rows: PlatformUpload["rows"];
  fileName: string;
  total: number;
  inCount: number;
  outCount: number;
  unknown: number;
  availCol: string | null;
  nameCol: string | null;
  idCol: string | null;
}

function downloadCsv(name: string, headers: string[], rows: (string | number | null | undefined)[][]) {
  const cell = (v: any) => { const s = v == null ? "" : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const csv = "﻿" + [headers, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a"); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url);
}

// Detect columns generically across all platform export shapes.
function parseWorkbook(wb: XLSX.WorkBook, fileName: string): Parsed | { error: string } {
  const sheet = wb.SheetNames.find((n) => n === "NonFoodProducts") ?? wb.SheetNames[0];
  const raw: Record<string, unknown>[] = XLSX.utils.sheet_to_json(wb.Sheets[sheet], { defval: "" });
  if (!raw.length) return { error: `الورقة "${sheet}" فاضية.` };
  const headers = Object.keys(raw[0]);
  const low = (h: string) => h.toLowerCase();

  const find = (test: (h: string) => boolean) => headers.find((h) => test(low(h)));
  const idCol =
    find((h) => h === "id" || h === "global_id" || h.includes("spi") || h.includes("uniqueidentifier") || h.includes("snoonu")) ||
    find((h) => h.includes("rafeeq") || (h.includes("product") && h.includes("id")) || h === "productid");
  const barcodeCol = find((h) => h.includes("barcode") || h === "ean" || h === "upc" || h.includes("باركود"));
  const skuCol = find((h) => h === "sku" || h.includes("sku"));
  const nameCol =
    find((h) => h === "name_en" || /product name \(en\)/.test(h)) ||
    find((h) => h === "name" || h.includes("name") || h.includes("اسم") || h.includes("product name") || h === "title");
  // Availability: prefer an explicit status/active/availability column, else a
  // branchStatus column, else fall back to a stock/quantity column.
  const availCol =
    find((h) => h === "availability" || h.startsWith("availability") || h === "status" || h.includes("active") ||
      h.includes("مفعل") || h.includes("الحالة") || h.includes("التوفر") || h.includes("التوفّر")) ||
    find((h) => h.endsWith("branchstatus")) ||
    find((h) => h.startsWith("stock") || h.includes("stock") || h === "quantity" || h === "qty" || h.includes("كمية") || h.includes("مخزون"));

  if (!availCol) return { error: `ما لقيت عمود التوفّر/الحالة. الأعمدة: ${headers.slice(0, 10).join(" · ")}…` };
  if (!nameCol && !idCol && !barcodeCol && !skuCol) return { error: `ما لقيت عمود اسم/مُعرّف. الأعمدة: ${headers.slice(0, 10).join(" · ")}…` };

  const rows: PlatformUpload["rows"] = [];
  let inCount = 0, outCount = 0, unknown = 0;
  for (const r of raw) {
    const available = cellToAvailable(r[availCol]);
    if (available === true) inCount++; else if (available === false) outCount++; else unknown++;
    rows.push({
      name: nameCol ? String(r[nameCol] ?? "") : undefined,
      id: idCol ? String(r[idCol] ?? "") : undefined,
      barcode: barcodeCol ? String(r[barcodeCol] ?? "") : undefined,
      sku: skuCol ? String(r[skuCol] ?? "") : undefined,
      available,
    });
  }
  return { rows, fileName, total: raw.length, inCount, outCount, unknown, availCol, nameCol: nameCol ?? null, idCol: idCol ?? null };
}

const CELL: Record<Avail, { t: string; c: string }> = {
  in: { t: "✅", c: "text-emerald-600" },
  out: { t: "⛔", c: "text-red-600" },
  absent: { t: "—", c: "text-slate-300" },
};

export default function AvailabilityReconcile() {
  const [parsed, setParsed] = useState<Record<string, Parsed>>({});
  const [fileErr, setFileErr] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [res, setRes] = useState<ReconcileResult | null>(null);
  const [capped, setCapped] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState<string | null>(null);
  const [shopMsg, setShopMsg] = useState<string | null>(null);
  const [pushing, setPushing] = useState(false);

  async function onFile(platform: string, e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setRes(null); setApplied(null); setShopMsg(null);
    setFileErr((m) => ({ ...m, [platform]: "" }));
    try {
      const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
      const out = parseWorkbook(wb, file.name);
      if ("error" in out) { setFileErr((m) => ({ ...m, [platform]: out.error })); setParsed((p) => { const n = { ...p }; delete n[platform]; return n; }); return; }
      setParsed((p) => ({ ...p, [platform]: out }));
    } catch (err) {
      setFileErr((m) => ({ ...m, [platform]: err instanceof Error ? err.message : "تعذّرت القراءة." }));
    }
  }

  async function runCompare() {
    const uploads: PlatformUpload[] = Object.entries(parsed).map(([platform, p]) => ({ platform, rows: p.rows }));
    if (!uploads.length) { setError("ارفع قائمة وحدة على الأقل."); return; }
    setBusy(true); setError(null); setRes(null); setApplied(null); setShopMsg(null);
    try {
      const out = await reconcileAvailabilityAction(uploads);
      if (!out.ok || !out.result) { setError(out.error ?? "فشلت المقارنة."); return; }
      setRes(out.result); setCapped(!!out.matrixCapped);
    } catch (e) {
      setError(e instanceof Error ? e.message : "خطأ غير متوقع.");
    } finally { setBusy(false); }
  }

  async function unify() {
    if (!res) return;
    if (!confirm(`توحيد التوفّر في النظام؟\nنافد: ${res.applyOutIds.length} · متوفّر: ${res.applyInIds.length}\nيُطبّق على كل المنصّات (Pure Seoul · Talabat · Rafeeq · Shopify).`)) return;
    setApplying(true); setApplied(null);
    try {
      const r = await applyReconciledAvailability(res.applyOutIds, res.applyInIds);
      if (r.error) { alert(r.error); return; }
      setApplied(`✓ توحّد على ${r.platforms} منصّات — نافد ${r.outOfStock} · متوفّر ${r.inStock}.`);
    } catch (e) { alert(e instanceof Error ? e.message : "تعذّر التطبيق."); }
    finally { setApplying(false); }
  }

  async function toShopify() {
    if (!res) return;
    const outSkus = res.matrix.filter((m) => m.reconciled === "out" && m.sku).map((m) => m.sku!) ;
    if (!outSkus.length) { setShopMsg("ما في SKU نافدة لدفعها."); return; }
    if (!confirm(`دفع ${outSkus.length} منتج نافد إلى Shopify (مخزون 0 + إلغاء الإدراج)؟`)) return;
    setPushing(true); setShopMsg(null);
    try {
      const r = await applyReconciledToShopify(outSkus);
      if (r.error) { setShopMsg(r.error); return; }
      const s = r.shopify;
      setShopMsg(
        s.configured
          ? `✓ Shopify: دُفع ${s.pushed} · فشل ${s.failed} · قنوات أُلغيت ${r.channelRows}.`
          : `أُلغي الإدراج بالنظام لـ ${r.channelRows} — لكن الدفع الحقيقي لـ Shopify غير مفعّل: ${s.message}`
      );
    } catch (e) { setShopMsg(e instanceof Error ? e.message : "تعذّر الدفع."); }
    finally { setPushing(false); }
  }

  const c = res?.counts;
  const cols = res?.platforms ?? [];

  return (
    <div className="space-y-4">
      {/* Upload slots */}
      <div className="grid gap-3 sm:grid-cols-2">
        {SOURCES.map((s) => {
          const p = parsed[s.key];
          const err = fileErr[s.key];
          return (
            <div key={s.key} className="card space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-ink">{s.label}</h3>
                {p ? <span className="text-xs text-emerald-600">✓ {p.total} صف</span> : null}
              </div>
              <p className="text-[11px] text-muted">{s.hint}</p>
              <input type="file" accept=".xlsx,.xls,.csv" onChange={(e) => onFile(s.key, e)} className="block w-full text-xs" />
              {p ? (
                <p className="text-[11px] text-muted">
                  متوفّر {p.inCount} · نافد {p.outCount}{p.unknown ? ` · غير معروف ${p.unknown}` : ""}
                  <br />عمود التوفّر: <code className="text-[10px]">{p.availCol}</code>
                </p>
              ) : null}
              {err ? <pre className="whitespace-pre-wrap rounded bg-red-50 px-2 py-1 text-[11px] text-red-700">{err}</pre> : null}
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-3">
        <button onClick={runCompare} disabled={busy || !Object.keys(parsed).length}
          className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-dark disabled:opacity-50">
          {busy ? "جاري المقارنة…" : "🔁 قارن ووحّد"}
        </button>
        {error ? <span className="text-sm text-red-700">{error}</span> : null}
      </div>

      {res && c ? (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="منتجات في المقارنة" value={c.products} />
            <Stat label="نافد (موحّد)" value={c.out} accent="red" />
            <Stat label="متوفّر (موحّد)" value={c.inStock} accent="emerald" />
            <Stat label="تعارضات" value={c.conflicts} accent="amber" />
          </div>

          {/* Unmatched per platform — surfaced, never silently dropped. */}
          {Object.entries(c.unmatchedByPlatform).some(([, n]) => n > 0) ? (
            <div className="card border-amber-200 bg-amber-50 text-xs text-amber-800">
              صفوف ما انطابقت بالكتالوج: {Object.entries(c.unmatchedByPlatform).filter(([, n]) => n > 0).map(([p, n]) => `${LABEL[p] ?? p} (${n})`).join(" · ")}.
              راجع الأسماء/المُعرّفات في تلك الملفات.
            </div>
          ) : null}

          {/* Apply bar */}
          <div className="card flex flex-col gap-2 border-emerald-200 bg-emerald-50/60 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h3 className="text-sm font-semibold text-ink">توحيد التوفّر في النظام</h3>
              <p className="text-xs text-muted">يكتب الحالة الموحّدة على كل المنصّات (نافد {c.out} · متوفّر {c.inStock}). لا يلمس الموافقة/الرفض.</p>
            </div>
            <button onClick={unify} disabled={applying || c.products === 0}
              className="shrink-0 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">
              {applying ? "جاري التوحيد…" : "✅ وحّد الكل"}
            </button>
          </div>
          {applied ? <p className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">{applied}</p> : null}

          {/* Shopify push */}
          <div className="card flex flex-col gap-2 border-violet-200 bg-violet-50/50 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h3 className="text-sm font-semibold text-ink">طبّق على Shopify</h3>
              <p className="text-xs text-muted">يضبط مخزون 0 للنافد ويلغي إدراجه على قناة Shopify عشان يطابق الكل.</p>
            </div>
            <button onClick={toShopify} disabled={pushing || c.out === 0}
              className="shrink-0 rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-50">
              {pushing ? "جاري الدفع…" : "🛒 ادفع للـ Shopify"}
            </button>
          </div>
          {shopMsg ? <p className="rounded-lg bg-violet-50 px-3 py-2 text-sm text-violet-800">{shopMsg}</p> : null}

          {/* Per-platform correction lists */}
          <div className="card space-y-2">
            <h3 className="text-sm font-semibold text-ink">قوائم التصحيح لكل منصّة (وش تخفي فيها)</h3>
            <p className="text-xs text-muted">منتجات نافدة (موحّد) لكنها لا زالت ظاهرة على المنصّة — نزّل القائمة وخفّها بلوحتها.</p>
            <div className="flex flex-wrap gap-2">
              {res.corrections.map((cor) => (
                <button key={cor.platform} disabled={!cor.hide.length}
                  onClick={() => downloadCsv(`${cor.platform}_hide_list.csv`, ["SKU", "Name EN", "Product ID"], cor.hide.map((h) => [h.sku, h.name_en, h.id]))}
                  className="btn-ghost px-3 py-1 text-xs disabled:opacity-40">
                  ⬇ {LABEL[cor.platform] ?? cor.platform} ({cor.hide.length})
                </button>
              ))}
            </div>
          </div>

          {/* Matrix */}
          <div className="card overflow-x-auto">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-ink">جدول المقارنة{capped ? " (أول 1500)" : ""}</h3>
              <div className="flex gap-2">
                <button className="btn-ghost px-2 py-1 text-xs" onClick={() => window.print()}>🖨️ PDF</button>
                <button className="btn-ghost px-2 py-1 text-xs"
                  onClick={() => downloadCsv(
                    "availability_matrix.csv",
                    ["SKU", "Name EN", ...cols.map((p) => LABEL[p] ?? p), "الموحّد", "تعارض"],
                    res.matrix.map((m) => [m.sku, m.name_en, ...cols.map((p) => m.perPlatform[p] ?? "absent"), m.reconciled, m.conflict ? "نعم" : ""])
                  )}>⬇ CSV</button>
              </div>
            </div>
            <table className="w-full text-right text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-muted">
                  <th className="py-1 pl-2 text-right font-medium">المنتج</th>
                  {cols.map((p) => <th key={p} className="px-1 text-center font-medium">{LABEL[p] ?? p}</th>)}
                  <th className="px-1 text-center font-medium">الموحّد</th>
                </tr>
              </thead>
              <tbody>
                {res.matrix.map((m) => (
                  <tr key={m.id} className={`border-b border-slate-50 ${m.conflict ? "bg-amber-50" : ""}`}>
                    <td className="py-1.5 pl-2">
                      <div className="flex items-center gap-2">
                        <Thumb src={m.image_url} />
                        <span>
                          <span className="text-ink">{m.name_en ?? "—"}</span>
                          {m.sku ? <span className="ml-1 font-mono text-[10px] text-muted">{m.sku}</span> : null}
                        </span>
                      </div>
                    </td>
                    {cols.map((p) => {
                      const a = m.perPlatform[p] ?? "absent";
                      return <td key={p} className={`px-1 text-center ${CELL[a].c}`}>{CELL[a].t}</td>;
                    })}
                    <td className={`px-1 text-center font-semibold ${m.reconciled === "out" ? "text-red-600" : "text-emerald-600"}`}>
                      {m.reconciled === "out" ? "⛔" : "✅"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {res.matrix.length === 0 ? <p className="py-3 text-center text-sm text-slate-400">لا شيء انطابق.</p> : null}
          </div>

          {/* Print-only PDF sheet: product cards with images + reconciled status.
              Hidden on screen; the browser's "Save as PDF" captures just this. */}
          <PrintSheet matrix={res.matrix} cols={cols} counts={c} capped={capped} />
        </>
      ) : null}
    </div>
  );
}

// Small square product thumbnail; falls back to a placeholder box.
function Thumb({ src, size = 28 }: { src?: string | null; size?: number }) {
  if (!src) {
    return (
      <span
        className="inline-flex shrink-0 items-center justify-center rounded bg-slate-100 text-[9px] text-slate-300"
        style={{ width: size, height: size }}
      >
        —
      </span>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      crossOrigin="anonymous"
      className="shrink-0 rounded border border-slate-100 object-cover"
      style={{ width: size, height: size }}
    />
  );
}

// Print-friendly comparison sheet. Renders a header, the count summary, and a
// product-card table (image + name/SKU + per-platform availability + reconciled).
function PrintSheet({
  matrix,
  cols,
  counts,
  capped,
}: {
  matrix: ReconcileResult["matrix"];
  cols: string[];
  counts: ReconcileResult["counts"];
  capped: boolean;
}) {
  return (
    <div id="avail-print" aria-hidden>
      <style>{`
        #avail-print { display: none; }
        @media print {
          body * { visibility: hidden !important; }
          #avail-print, #avail-print * { visibility: visible !important; }
          #avail-print { display: block !important; position: absolute; inset: 0; width: 100%; padding: 6mm; color: #0f172a; }
          #avail-print table { width: 100%; border-collapse: collapse; font-size: 10px; }
          #avail-print th, #avail-print td { border: 1px solid #e2e8f0; padding: 3px 4px; }
          #avail-print thead { display: table-header-group; }
          #avail-print tr { page-break-inside: avoid; }
          #avail-print img { width: 34px; height: 34px; object-fit: cover; border-radius: 4px; }
          @page { size: A4 landscape; margin: 8mm; }
        }
      `}</style>

      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 8 }}>
        <h1 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>تقرير مطابقة التوفّر بين المنصّات</h1>
        <span style={{ fontSize: 11, color: "#64748b" }}>
          {SOURCES.map((s) => s.label).join(" · ")}
        </span>
      </div>
      <p style={{ fontSize: 11, color: "#334155", margin: "0 0 8px" }}>
        منتجات: {counts.products} · نافد (موحّد): {counts.out} · متوفّر (موحّد): {counts.inStock} · تعارضات: {counts.conflicts}
        {capped ? " · (معروض أول 1500)" : ""}
      </p>

      <table dir="rtl">
        <thead>
          <tr style={{ background: "#f8fafc" }}>
            <th style={{ width: 44 }}>صورة</th>
            <th style={{ textAlign: "right" }}>المنتج</th>
            {cols.map((p) => (
              <th key={p} style={{ textAlign: "center" }}>{LABEL[p] ?? p}</th>
            ))}
            <th style={{ textAlign: "center" }}>الموحّد</th>
          </tr>
        </thead>
        <tbody>
          {matrix.map((m) => (
            <tr key={m.id} style={m.conflict ? { background: "#fffbeb" } : undefined}>
              <td style={{ textAlign: "center" }}>
                {m.image_url ? <img src={m.image_url} alt="" crossOrigin="anonymous" /> : "—"}
              </td>
              <td style={{ textAlign: "right" }}>
                <div style={{ fontWeight: 600 }}>{m.name_en ?? "—"}</div>
                {m.sku ? <div style={{ fontFamily: "monospace", fontSize: 9, color: "#64748b" }}>{m.sku}</div> : null}
              </td>
              {cols.map((p) => {
                const a = m.perPlatform[p] ?? "absent";
                return <td key={p} style={{ textAlign: "center" }}>{CELL[a].t}</td>;
              })}
              <td style={{ textAlign: "center", fontWeight: 700, color: m.reconciled === "out" ? "#dc2626" : "#059669" }}>
                {m.reconciled === "out" ? "⛔" : "✅"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: string }) {
  const color = accent === "amber" ? "text-amber-700" : accent === "red" ? "text-red-600" : accent === "emerald" ? "text-emerald-700" : "text-ink";
  return <div className="card"><p className="text-xs text-muted">{label}</p><p className={`text-xl font-semibold ${color}`}>{value}</p></div>;
}
