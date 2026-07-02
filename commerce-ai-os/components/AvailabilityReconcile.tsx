"use client";

import { useMemo, useState } from "react";
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
  raw: Record<string, unknown>[];
  headers: string[];
  fileName: string;
  total: number;
  availColAuto: string;   // auto-detected availability column (the default)
  nameCol: string | null;
  idCol: string | null;
  barcodeCol: string | null;
  skuCol: string | null;
}

// Build the normalized upload rows + counts from a chosen availability column.
// Kept separate from detection so the user can override the column per file.
function buildRows(p: Parsed, availCol: string): { rows: PlatformUpload["rows"]; inCount: number; outCount: number; unknown: number } {
  const rows: PlatformUpload["rows"] = [];
  let inCount = 0, outCount = 0, unknown = 0;
  for (const r of p.raw) {
    const available = cellToAvailable(r[availCol]);
    if (available === true) inCount++; else if (available === false) outCount++; else unknown++;
    rows.push({
      name: p.nameCol ? String(r[p.nameCol] ?? "") : undefined,
      id: p.idCol ? String(r[p.idCol] ?? "") : undefined,
      barcode: p.barcodeCol ? String(r[p.barcodeCol] ?? "") : undefined,
      sku: p.skuCol ? String(r[p.skuCol] ?? "") : undefined,
      available,
    });
  }
  return { rows, inCount, outCount, unknown };
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
  // Product name — prefer an explicit product-name column over a category/
  // subcategory name (Rafeeq sheets carry both; "category_name_english" must
  // never win), then fall back to a generic name column.
  const nameCol =
    find((h) => h === "name_en" || h === "product_name_english" || /product[_ ]name.*(en|english)/.test(h)) ||
    find((h) => /product name \(en\)/.test(h) || h === "name" || h === "title" || h.includes("product_name") || h.includes("product name")) ||
    find((h) => h.includes("اسم المنتج")) ||
    find((h) => h.includes("name") || h.includes("اسم"));
  // Availability: the "availability/in-stock" concept must beat a generic
  // active/status flag. Rafeeq carries product_availability (real 0/1 stock)
  // alongside active=1 always — picking "active" would mark everything in stock.
  // Order: explicit availability → status/active → branchStatus → stock/qty.
  const availCol =
    find((h) => h === "availability" || h.includes("availability") || h.includes("in_stock") || h.includes("instock") ||
      h.includes("التوفر") || h.includes("التوفّر") || h.includes("متوفر")) ||
    find((h) => h === "status" || h.includes("active") || h.includes("مفعل") || h.includes("الحالة")) ||
    find((h) => h.endsWith("branchstatus")) ||
    find((h) => h.startsWith("stock") || h.includes("stock") || h === "quantity" || h === "qty" || h.includes("كمية") || h.includes("مخزون"));

  if (!availCol) return { error: `ما لقيت عمود التوفّر/الحالة. الأعمدة: ${headers.slice(0, 10).join(" · ")}…` };
  if (!nameCol && !idCol && !barcodeCol && !skuCol) return { error: `ما لقيت عمود اسم/مُعرّف. الأعمدة: ${headers.slice(0, 10).join(" · ")}…` };

  return {
    raw, headers, fileName, total: raw.length,
    availColAuto: availCol,
    nameCol: nameCol ?? null, idCol: idCol ?? null,
    barcodeCol: barcodeCol ?? null, skuCol: skuCol ?? null,
  };
}

const CELL: Record<Avail, { t: string; c: string }> = {
  in: { t: "✅", c: "text-emerald-600" },
  out: { t: "⛔", c: "text-red-600" },
  absent: { t: "—", c: "text-slate-300" },
};

export default function AvailabilityReconcile() {
  const [parsed, setParsed] = useState<Record<string, Parsed>>({});
  const [availChoice, setAvailChoice] = useState<Record<string, string>>({}); // per-platform column override
  const [fileErr, setFileErr] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [res, setRes] = useState<ReconcileResult | null>(null);
  const [capped, setCapped] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState<string | null>(null);
  const [shopMsg, setShopMsg] = useState<string | null>(null);
  const [pushing, setPushing] = useState(false);
  // View filters — apply to the on-screen table, CSV, and PDF alike so the user
  // can print one status ("كل حاله") or one platform's comparison ("كل مقارنة").
  const [statusFilter, setStatusFilter] = useState<"all" | "out" | "in" | "conflict">("all");
  const [platformFilter, setPlatformFilter] = useState<string>("all");

  const filtered = useMemo(() => {
    if (!res) return [];
    return res.matrix.filter((m) => {
      if (statusFilter === "out" && m.reconciled !== "out") return false;
      if (statusFilter === "in" && m.reconciled !== "in") return false;
      if (statusFilter === "conflict" && !m.conflict) return false;
      if (platformFilter !== "all" && (m.perPlatform[platformFilter] ?? "absent") === "absent") return false;
      return true;
    });
  }, [res, statusFilter, platformFilter]);

  // Effective availability column per platform (override or auto-detected) and
  // the rows/counts built from it. Re-derives whenever a file or override changes.
  const built = useMemo(() => {
    const out: Record<string, { availCol: string; rows: PlatformUpload["rows"]; inCount: number; outCount: number; unknown: number }> = {};
    for (const [platform, p] of Object.entries(parsed)) {
      const availCol = (availChoice[platform] && p.headers.includes(availChoice[platform])) ? availChoice[platform] : p.availColAuto;
      out[platform] = { availCol, ...buildRows(p, availCol) };
    }
    return out;
  }, [parsed, availChoice]);

  async function onFile(platform: string, e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setRes(null); setApplied(null); setShopMsg(null);
    setFileErr((m) => ({ ...m, [platform]: "" }));
    setAvailChoice((m) => { const n = { ...m }; delete n[platform]; return n; }); // reset override for new file
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
    const uploads: PlatformUpload[] = Object.entries(parsed).map(([platform, p]) => ({ platform, rows: built[platform]?.rows ?? buildRows(p, p.availColAuto).rows }));
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

  const STATUS_LABEL: Record<string, string> = { all: "كل الحالات", out: "النافد فقط", in: "المتوفّر فقط", conflict: "التعارضات فقط" };
  function filterLabel() {
    const parts = [STATUS_LABEL[statusFilter]];
    if (platformFilter !== "all") parts.push(`منصّة: ${LABEL[platformFilter] ?? platformFilter}`);
    return parts.join(" · ");
  }

  // Build a self-contained report document and print it from a fresh window.
  // A new window (not the app page) avoids the Vercel preview toolbar and the
  // app chrome, so "Save as PDF" reliably captures only the comparison.
  function printPdf() {
    if (!filtered.length) { alert("ما في صفوف بهذا الفلتر."); return; }
    const w = window.open("", "_blank");
    if (!w) { alert("اسمح بالنوافذ المنبثقة (popups) عشان نطبع الـ PDF."); return; }
    const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]!));
    const outN = filtered.filter((m) => m.reconciled === "out").length;
    const inN = filtered.filter((m) => m.reconciled === "in").length;
    const confN = filtered.filter((m) => m.conflict).length;
    const head = cols.map((p) => `<th class="ctr">${esc(LABEL[p] ?? p)}</th>`).join("");
    const rows = filtered.map((m) => {
      const cells = cols.map((p) => `<td class="ctr">${CELL[m.perPlatform[p] ?? "absent"].t}</td>`).join("");
      const img = m.image_url ? `<img src="${esc(m.image_url)}" referrerpolicy="no-referrer">` : "—";
      return `<tr class="${m.conflict ? "conf" : ""}"><td class="ctr">${img}</td>`
        + `<td class="nm"><b>${esc(m.name_en ?? "—")}</b>${m.sku ? `<div class="sku">${esc(m.sku)}</div>` : ""}</td>`
        + `${cells}<td class="ctr rec ${m.reconciled}">${m.reconciled === "out" ? "⛔" : "✅"}</td></tr>`;
    }).join("");
    w.document.write(`<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8">
<title>تقرير مطابقة التوفّر</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", Tahoma, Arial, sans-serif; color: #0f172a; margin: 0; padding: 14px; }
  h1 { font-size: 17px; margin: 0; }
  .sub { font-size: 11px; color: #64748b; }
  .hd { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; border-bottom: 2px solid #0f172a; padding-bottom: 6px; margin-bottom: 8px; }
  .meta { font-size: 11px; color: #334155; margin-bottom: 8px; }
  table { width: 100%; border-collapse: collapse; font-size: 10px; }
  th, td { border: 1px solid #e2e8f0; padding: 3px 5px; }
  thead { display: table-header-group; background: #f1f5f9; }
  tr { page-break-inside: avoid; }
  .ctr { text-align: center; }
  .nm { text-align: right; }
  .sku { font-family: monospace; font-size: 9px; color: #64748b; }
  .conf { background: #fffbeb; }
  .rec.out { color: #dc2626; font-weight: 700; }
  .rec.in { color: #059669; font-weight: 700; }
  img { width: 34px; height: 34px; object-fit: cover; border-radius: 4px; vertical-align: middle; }
  @page { size: A4 landscape; margin: 8mm; }
</style></head><body>
<div class="hd"><div><h1>تقرير مطابقة التوفّر بين المنصّات</h1><div class="sub">${esc(SOURCES.map((s) => s.label).join(" · "))}</div></div>
<div class="sub">${esc(filterLabel())}</div></div>
<div class="meta">منتجات: ${filtered.length} · نافد: ${outN} · متوفّر: ${inN} · تعارضات: ${confN}${capped ? " · (أول 1500)" : ""}</div>
<table><thead><tr><th class="ctr">صورة</th><th class="nm">المنتج</th>${head}<th class="ctr">الموحّد</th></tr></thead><tbody>${rows}</tbody></table>
<script>
  function go(){ window.focus(); window.print(); }
  var imgs = Array.prototype.slice.call(document.images), left = imgs.length;
  if (!left) { setTimeout(go, 100); }
  else {
    var done = function(){ if (--left <= 0) setTimeout(go, 150); };
    imgs.forEach(function(im){ if (im.complete) done(); else { im.onload = done; im.onerror = done; } });
    setTimeout(go, 4000); // fallback so slow images never block printing
  }
<\/script>
</body></html>`);
    w.document.close();
  }

  return (
    <div className="space-y-4">
      {/* Upload slots */}
      <div className="grid gap-3 sm:grid-cols-2">
        {SOURCES.map((s) => {
          const p = parsed[s.key];
          const b = built[s.key];
          const err = fileErr[s.key];
          const overridden = !!p && b && b.availCol !== p.availColAuto;
          return (
            <div key={s.key} className="card space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-ink">{s.label}</h3>
                {p ? <span className="text-xs text-emerald-600">✓ {p.total} صف</span> : null}
              </div>
              <p className="text-[11px] text-muted">{s.hint}</p>
              <input type="file" accept=".xlsx,.xls,.csv" onChange={(e) => onFile(s.key, e)} className="block w-full text-xs" />
              {p && b ? (
                <>
                  <p className="text-[11px] text-muted">
                    متوفّر {b.inCount} · نافد {b.outCount}{b.unknown ? ` · غير معروف ${b.unknown}` : ""}
                  </p>
                  <label className="block text-[11px] text-muted">
                    عمود التوفّر:
                    <select
                      value={b.availCol}
                      onChange={(e) => { setAvailChoice((m) => ({ ...m, [s.key]: e.target.value })); setRes(null); }}
                      className={`mt-0.5 block w-full rounded-sm border px-1 py-0.5 text-[11px] ${overridden ? "border-amber-400 bg-amber-50" : "border-slate-200"}`}>
                      {p.headers.map((h) => (
                        <option key={h} value={h}>{h === p.availColAuto ? `${h} (تلقائي)` : h}</option>
                      ))}
                    </select>
                  </label>
                  {overridden ? <p className="text-[10px] text-amber-700">⚠ تجاوزت العمود التلقائي.</p> : null}
                </>
              ) : null}
              {err ? <pre className="whitespace-pre-wrap rounded-sm bg-red-50 px-2 py-1 text-[11px] text-red-700">{err}</pre> : null}
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
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-ink">جدول المقارنة{capped ? " (أول 1500)" : ""}</h3>
              <div className="flex gap-2">
                <button className="btn-ghost px-2 py-1 text-xs" onClick={printPdf}>🖨️ PDF</button>
                <button className="btn-ghost px-2 py-1 text-xs"
                  onClick={() => downloadCsv(
                    "availability_matrix.csv",
                    ["SKU", "Name EN", ...cols.map((p) => LABEL[p] ?? p), "الموحّد", "تعارض"],
                    filtered.map((m) => [m.sku, m.name_en, ...cols.map((p) => m.perPlatform[p] ?? "absent"), m.reconciled, m.conflict ? "نعم" : ""])
                  )}>⬇ CSV</button>
              </div>
            </div>

            {/* Filters — pick a status and/or one platform, then طبّق/CSV/PDF يتبع الفلتر. */}
            <div className="mb-2 flex flex-wrap items-center gap-1.5 text-xs">
              <span className="text-muted">الحالة:</span>
              {([
                ["all", `الكل (${c.products})`],
                ["out", `نافد (${c.out})`],
                ["in", `متوفّر (${c.inStock})`],
                ["conflict", `تعارض (${c.conflicts})`],
              ] as const).map(([k, lbl]) => (
                <button key={k} onClick={() => setStatusFilter(k)}
                  className={`rounded-full px-2.5 py-0.5 ${statusFilter === k ? "bg-brand text-white" : "bg-slate-100 text-ink hover:bg-slate-200"}`}>
                  {lbl}
                </button>
              ))}
              <span className="ml-2 text-muted">المنصّة:</span>
              <button onClick={() => setPlatformFilter("all")}
                className={`rounded-full px-2.5 py-0.5 ${platformFilter === "all" ? "bg-brand text-white" : "bg-slate-100 text-ink hover:bg-slate-200"}`}>الكل</button>
              {cols.map((p) => (
                <button key={p} onClick={() => setPlatformFilter(p)}
                  className={`rounded-full px-2.5 py-0.5 ${platformFilter === p ? "bg-brand text-white" : "bg-slate-100 text-ink hover:bg-slate-200"}`}>
                  {LABEL[p] ?? p}
                </button>
              ))}
              <span className="ml-auto text-muted">معروض: {filtered.length}</span>
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
                {filtered.map((m) => (
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
            {filtered.length === 0 ? <p className="py-3 text-center text-sm text-slate-400">{res.matrix.length ? "ما في صفوف بهذا الفلتر." : "لا شيء انطابق."}</p> : null}
          </div>
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
        className="inline-flex shrink-0 items-center justify-center rounded-sm bg-slate-100 text-[9px] text-slate-300"
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
      referrerPolicy="no-referrer"
      className="shrink-0 rounded-sm border border-slate-100 object-cover"
      style={{ width: size, height: size }}
    />
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: string }) {
  const color = accent === "amber" ? "text-amber-700" : accent === "red" ? "text-red-600" : accent === "emerald" ? "text-emerald-700" : "text-ink";
  return <div className="card"><p className="text-xs text-muted">{label}</p><p className={`text-xl font-semibold ${color}`}>{value}</p></div>;
}
