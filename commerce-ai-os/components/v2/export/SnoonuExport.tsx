"use client";

// INT.2C — Snoonu multi-store export surface (presentational + client state).
//
// Renders ONE Snoonu storefront's certified preview (product grain) with the four
// export modes (All / New / Updates / Selected), a pre-generation plan + grouped
// blocked reasons, and a writer-gated "Generate Package" that streams the ZIP and
// shows the post-generation summary. It holds only view state — no I/O, no
// mutation, no identity re-derivation. New = unmapped (no storefront SPI);
// Updates = already-mapped (resend) — never a fabricated change diff.

import { useMemo, useState } from "react";
import type { ExportItemStatus, ExportReasonCode } from "@/lib/export/validation";
import { paginate, DEFAULT_PAGE_SIZE } from "@/lib/ui/pagination";
import { toggleKey, selectKeys, clearSelection, allSelected, countSelectedWithin } from "@/lib/ui/selection";
import SelectionToolbar from "@/components/v2/ui/SelectionToolbar";
import EmptyState from "@/components/v2/ui/EmptyState";

export interface SnoonuRowVM {
  id: string;
  sku: string;
  barcode: string | null;
  title: string;
  category: string | null;
  price: number | null;
  spi: string | null;
  snoonuStatus: "Listed" | "Not Listed" | "Needs Review";
  hasImage: boolean;
  imageExportName: string | null;
  imageCount: number;
  status: ExportItemStatus;
  reasons: { code: ExportReasonCode; blocking: boolean }[];
}

export interface SnoonuExportVM {
  unit: "malikas" | "pure-seoul";
  storefrontKey: string;
  label: string;
  canWrite: boolean;
  rows: SnoonuRowVM[];
  counts: { productCount: number; mappedCount: number; unmappedCount: number };
}

type Mode = "all" | "new" | "updates" | "selected";

const REASON_LABEL: Record<string, string> = {
  MISSING_SKU: "SKU مفقود", DUPLICATE_SKU: "SKU مكرّر", MISSING_BARCODE: "باركود مفقود",
  DUPLICATE_BARCODE: "باركود مكرّر", INVALID_BARCODE: "صيغة باركود غير قياسية", MISSING_IMAGE: "صورة مفقودة",
  MISSING_TITLE: "عنوان مفقود", MISSING_PRICE: "سعر مفقود", MISSING_CATEGORY: "فئة مفقودة",
  LIFECYCLE_NOT_ELIGIBLE: "غير مؤهّل (دورة الحياة)", IDENTITY_MISSING: "هوية مفقودة",
  IDENTITY_CONFLICT: "تعارض هوية", IDENTITY_NEEDS_REVIEW: "ربط بحاجة لمراجعة",
  VARIANT_NOT_READY: "متغيّر غير جاهز", UNSUPPORTED: "غير مدعوم",
};
const STATUS_LABEL: Record<ExportItemStatus, string> = { READY: "جاهز", WARNING: "تحذير", BLOCKED: "محظور", UNKNOWN: "غير معروف" };
const MODE_LABEL: Record<Mode, string> = { all: "الكل", new: "جديد (غير مربوط)", updates: "تحديثات (مربوط)", selected: "المحدد" };

function inMode(r: SnoonuRowVM, mode: Mode, selected: ReadonlySet<string>): boolean {
  if (r.status === "BLOCKED") return false;
  if (mode === "all") return true;
  if (mode === "new") return r.spi === null;
  if (mode === "updates") return r.spi !== null;
  return selected.has(r.id);
}

export default function SnoonuExport({ vm }: { vm: SnoonuExportVM }) {
  const [mode, setMode] = useState<Mode>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<"ALL" | ExportItemStatus>("ALL");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Record<string, string> | null>(null);

  // Pre-generation plan for the chosen mode (client mirror of the pure resolver).
  const plan = useMemo(() => {
    let ready = 0, warn = 0, blocked = 0, mapped = 0, unmapped = 0, included = 0, images = 0;
    const blockers: Partial<Record<ExportReasonCode, number>> = {};
    for (const r of vm.rows) {
      if (r.status === "READY") ready++; else if (r.status === "WARNING") warn++; else if (r.status === "BLOCKED") blocked++;
      if (r.spi !== null) mapped++; else unmapped++;
      if (r.status === "BLOCKED") { for (const x of r.reasons) if (x.blocking) blockers[x.code] = (blockers[x.code] ?? 0) + 1; continue; }
      if (inMode(r, mode, selected)) { included++; images += r.hasImage ? Math.max(1, r.imageCount) : 0; }
    }
    return { ready, warn, blocked, mapped, unmapped, included, images, blockers };
  }, [vm.rows, mode, selected]);

  // Filtered view for the table.
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return vm.rows.filter((r) => {
      if (status !== "ALL" && r.status !== status) return false;
      if (needle) {
        const hay = `${r.sku} ${r.title} ${r.barcode ?? ""} ${r.spi ?? ""}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [vm.rows, status, q]);

  const pageView = useMemo(() => paginate(filtered, page, DEFAULT_PAGE_SIZE), [filtered, page]);
  // Only exportable (not-blocked) rows are selectable for the "Selected" mode.
  const selectableAllKeys = useMemo(() => vm.rows.filter((r) => r.status !== "BLOCKED").map((r) => r.id), [vm.rows]);
  const selectablePageKeys = useMemo(() => pageView.pageItems.filter((r) => r.status !== "BLOCKED").map((r) => r.id), [pageView]);
  const selectedCount = countSelectedWithin(selected, selectableAllKeys);

  async function generate() {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/export/snoonu/${vm.unit}/package`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mode === "selected" ? { mode, selectedKeys: [...selected] } : { mode }),
      });
      if (!res.ok) { setError((await res.text().catch(() => "")) || "تعذّر توليد الحزمة الآن."); return; }
      const h = res.headers;
      const summary: Record<string, string> = {
        filename: h.get("X-Snoonu-Output-Filename") ?? "snoonu-export.zip",
        rows: h.get("X-Snoonu-Product-Rows") ?? "0",
        mapped: h.get("X-Snoonu-Mapped") ?? "0",
        unmapped: h.get("X-Snoonu-Unmapped") ?? "0",
        images: h.get("X-Snoonu-Image-Count") ?? "0",
        warnings: h.get("X-Snoonu-Warning-Count") ?? "0",
        excludedBlocked: h.get("X-Snoonu-Excluded-Blocked") ?? "0",
        generatedAt: h.get("X-Snoonu-Generated-At") ?? "",
        generatedBy: h.get("X-Snoonu-Generated-By") ?? "",
      };
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = summary.filename;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      setResult(summary);
    } catch { setError("تعذّر الاتصال بالخادم — الرجاء المحاولة لاحقاً."); }
    finally { setBusy(false); }
  }

  const chip = (active: boolean) => `rounded-full border px-3 py-1 text-xs transition-colors ${active ? "border-brand bg-brand-light text-brand" : "border-slate-200 bg-white text-muted hover:bg-slate-50"}`;
  const blockerEntries = Object.entries(plan.blockers).filter(([, n]) => (n ?? 0) > 0);

  return (
    <div className="space-y-4">
      <p className="text-[11px] text-muted">
        حبيبة التصدير: منتج — صف واحد لكل منتج. الهوية (SPI) مقروءة من ECL لهذا المتجر فقط
        (<span dir="ltr">{vm.storefrontKey}</span>) — لا تُشارَك بين ماليكاز وبيور سيؤول، ولا تُخمَّن للمنتجات الجديدة.
      </p>

      {/* Summary */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <Card value={vm.counts.productCount} label="منتجات" tone="ink" />
        <Card value={plan.ready} label="جاهز" tone="emerald" />
        <Card value={plan.warn} label="تحذير" tone="amber" />
        <Card value={plan.blocked} label="محظور" tone="rose" />
        <Card value={vm.counts.mappedCount} label="مربوط (SPI)" tone="ink" />
      </div>

      {/* Mode selector */}
      <div className="card space-y-2">
        <div className="text-sm font-semibold text-ink">وضع التصدير</div>
        <div className="flex flex-wrap gap-1.5">
          {(["all", "new", "updates", "selected"] as Mode[]).map((m) => (
            <button key={m} type="button" onClick={() => setMode(m)} className={chip(mode === m)}>{MODE_LABEL[m]}</button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2 text-[11px] text-muted sm:grid-cols-4">
          <Stat label="سيُضمَّن" value={plan.included} />
          <Stat label="صور متوقّعة" value={plan.images} />
          <Stat label="مربوط" value={plan.mapped} />
          <Stat label="غير مربوط (جديد)" value={plan.unmapped} />
        </div>
        {blockerEntries.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {blockerEntries.map(([code, n]) => (
              <span key={code} className="rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 text-[11px] text-rose-700">{REASON_LABEL[code] ?? code} · {n}</span>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {vm.canWrite ? (
            <button type="button" onClick={generate} disabled={busy || plan.included === 0} className="btn-primary disabled:cursor-not-allowed disabled:opacity-50">
              {busy ? "جارٍ التوليد…" : `توليد الحزمة (${plan.included})`}
            </button>
          ) : (
            <span className="text-[11px] text-muted">🔒 توليد الحزمة متاح لأصحاب صلاحية التعديل فقط.</span>
          )}
          <button type="button" disabled className="btn-ghost cursor-not-allowed opacity-50" title="غير متاح في هذه المرحلة">نشر إلى سنونو (غير متاح)</button>
        </div>
        {error && <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700" dir="auto">{error}</div>}
        {result && (
          <div className="space-y-1 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-[11px] text-emerald-900">
            <div className="text-xs font-semibold text-emerald-800">تم توليد الحزمة وتنزيلها</div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
              <Row label="الملف" value={result.filename} ltr />
              <Row label="الصفوف" value={result.rows} />
              <Row label="مربوط" value={result.mapped} />
              <Row label="غير مربوط" value={result.unmapped} />
              <Row label="الصور" value={result.images} />
              <Row label="تحذيرات" value={result.warnings} />
              <Row label="محظور مُستبعَد" value={result.excludedBlocked} />
              <Row label="بواسطة" value={result.generatedBy} ltr />
            </div>
          </div>
        )}
      </div>

      {/* Selection toolbar (only meaningful in "selected" mode) */}
      {mode === "selected" && (
        <SelectionToolbar
          selectedCount={selectedCount}
          total={selectableAllKeys.length}
          pageCount={selectablePageKeys.length}
          pageAllSelected={allSelected(selected, selectablePageKeys)}
          onSelectPage={() => setSelected((prev) => selectKeys(prev, selectablePageKeys))}
          onSelectAllFiltered={() => setSelected((prev) => selectKeys(prev, selectableAllKeys))}
          onClear={() => setSelected(clearSelection())}
        />
      )}

      {/* Filters */}
      <div className="card flex flex-wrap items-center gap-2">
        {(["ALL", "READY", "WARNING", "BLOCKED"] as ("ALL" | ExportItemStatus)[]).map((sv) => (
          <button key={sv} type="button" onClick={() => { setStatus(sv); setPage(1); }} className={chip(status === sv)}>{sv === "ALL" ? "كل الحالات" : STATUS_LABEL[sv]}</button>
        ))}
        <input type="search" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="بحث SKU / اسم / SPI…" className="min-w-[12rem] flex-1 rounded-lg border border-slate-200 bg-white px-3 py-1 text-xs text-ink" />
        <span className="text-[11px] text-muted">يعرض {pageView.pageItems.length} من {filtered.length}</span>
      </div>

      {/* Table */}
      {filtered.length === 0 ? (
        <EmptyState title="لا توجد صفوف مطابقة" message="لا توجد منتجات مطابقة للفلاتر الحالية لهذا المتجر. جرّب تغيير الحالة أو مسح البحث." />
      ) : (
        <>
          <div className="card overflow-x-auto p-0">
            <table className="w-full min-w-[820px] text-right text-xs">
              <thead className="border-b border-slate-200 bg-slate-50 text-[11px] text-muted">
                <tr>
                  {mode === "selected" && (
                    <th className="px-3 py-2 text-center">
                      <input type="checkbox" checked={selectablePageKeys.length > 0 && allSelected(selected, selectablePageKeys)}
                        onChange={() => setSelected((prev) => allSelected(prev, selectablePageKeys) ? new Set([...prev].filter((k) => !selectablePageKeys.includes(k))) : selectKeys(prev, selectablePageKeys))}
                        disabled={!vm.canWrite} aria-label="تحديد الصفحة" />
                    </th>
                  )}
                  <th className="px-3 py-2 font-medium">SKU</th>
                  <th className="px-3 py-2 font-medium">المنتج</th>
                  <th className="px-3 py-2 font-medium">الفئة</th>
                  <th className="px-3 py-2 font-medium">SPI (سنونو)</th>
                  <th className="px-3 py-2 font-medium">حالة الإدراج</th>
                  <th className="px-3 py-2 font-medium">الصورة</th>
                  <th className="px-3 py-2 font-medium">التحقق</th>
                  <th className="px-3 py-2 font-medium">السبب</th>
                </tr>
              </thead>
              <tbody>
                {pageView.pageItems.map((r) => {
                  const isSel = mode === "selected" && selected.has(r.id);
                  const accent = isSel ? "bg-blue-50 border-s-4 border-s-blue-400"
                    : r.status === "BLOCKED" ? "border-s-4 border-s-rose-400"
                    : r.status === "WARNING" ? "border-s-4 border-s-amber-400"
                    : "border-s-4 border-s-emerald-400";
                  return (
                    <tr key={r.id} className={`border-b border-slate-100 last:border-0 ${accent}`}>
                      {mode === "selected" && (
                        <td className="px-3 py-2 text-center">{r.status !== "BLOCKED" ? <input type="checkbox" checked={selected.has(r.id)} onChange={() => setSelected((prev) => toggleKey(prev, r.id))} disabled={!vm.canWrite} aria-label={`تحديد ${r.sku}`} /> : null}</td>
                      )}
                      <td className="px-3 py-2 font-mono text-[11px]" dir="ltr">{r.sku || <span className="text-rose-600">—</span>}</td>
                      <td className="px-3 py-2 text-ink">{r.title || <span className="text-rose-600">بدون عنوان</span>}</td>
                      <td className="px-3 py-2 text-muted">{r.category ?? "—"}</td>
                      <td className="px-3 py-2 font-mono text-[11px]" dir="ltr">{r.spi ?? <span className="text-amber-600">جديد</span>}</td>
                      <td className="px-3 py-2">{r.snoonuStatus}</td>
                      <td className="px-3 py-2 font-mono text-[10px] text-muted" dir="ltr">{r.hasImage ? (r.imageExportName ?? "—") : <span className="text-rose-600">مفقودة</span>}</td>
                      <td className="px-3 py-2"><span className={`inline-block rounded-full border px-2 py-0.5 text-[10px] ${r.status === "READY" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : r.status === "WARNING" ? "border-amber-200 bg-amber-50 text-amber-700" : r.status === "BLOCKED" ? "border-rose-200 bg-rose-50 text-rose-700" : "border-slate-200 bg-slate-50 text-slate-600"}`}>{STATUS_LABEL[r.status]}</span></td>
                      <td className="px-3 py-2">{r.reasons.length === 0 ? <span className="text-emerald-600">—</span> : (
                        <div className="flex flex-wrap gap-1">{r.reasons.map((x, i) => <span key={`${x.code}:${i}`} className={`rounded px-1.5 py-0.5 text-[10px] ${x.blocking ? "bg-rose-50 text-rose-600" : "bg-amber-50 text-amber-700"}`}>{REASON_LABEL[x.code] ?? x.code}</span>)}</div>
                      )}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between gap-2 px-1 text-xs text-muted">
            <span className="tabular-nums">{pageView.from}–{pageView.to} من {pageView.total}</span>
            <div className="flex items-center gap-1">
              <button type="button" onClick={() => setPage(pageView.page - 1)} disabled={pageView.page <= 1} className="rounded-lg border border-slate-300 px-2 py-1 hover:bg-slate-50 disabled:opacity-40">السابق</button>
              <span className="tabular-nums">{pageView.page}/{pageView.pageCount}</span>
              <button type="button" onClick={() => setPage(pageView.page + 1)} disabled={pageView.page >= pageView.pageCount} className="rounded-lg border border-slate-300 px-2 py-1 hover:bg-slate-50 disabled:opacity-40">التالي</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Card({ value, label, tone }: { value: number; label: string; tone: "ink" | "emerald" | "amber" | "rose" }) {
  const cls: Record<string, string> = { ink: "border-slate-200 text-ink", emerald: "border-emerald-200 bg-emerald-50 text-emerald-700", amber: "border-amber-200 bg-amber-50 text-amber-700", rose: "border-rose-200 bg-rose-50 text-rose-700" };
  return <div className={`rounded-lg border p-3 text-center ${cls[tone]}`}><div className="text-xl font-bold">{value}</div><div className="mt-0.5 text-[10px] text-muted">{label}</div></div>;
}
function Stat({ label, value }: { label: string; value: number }) {
  return <div className="rounded-lg border border-slate-200 px-2 py-1.5 text-center"><div className="text-sm font-semibold text-ink">{value}</div><div className="text-[10px] text-muted">{label}</div></div>;
}
function Row({ label, value, ltr }: { label: string; value: string; ltr?: boolean }) {
  return <div className="flex items-center justify-between gap-2"><span className="text-emerald-700">{label}</span><span className="font-mono" dir={ltr ? "ltr" : undefined}>{value || "—"}</span></div>;
}
