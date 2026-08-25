"use client";

// INT.2B — Talabat sellable-listing preview (presentational + client filtering).
// Renders the REAL adapter output: summary (total/ready/warnings/blocked),
// grouped blocking/warning reasons, and a filterable sellable-row table
// (SKU / Product·Variant / Barcode / Price / Image / Status / Reason). It holds
// only view state (filters) — no I/O, no mutation. Every row is a sellable
// listing: a simple product is one row; a variant product contributes one
// independent row per variant (NO parent row). The rows arrive pre-flattened +
// pre-validated from the pure buildTalabatPreview; this component never re-derives
// a rule.

import { useMemo, useState } from "react";
import type { ExportReasonCode } from "@/lib/export/validation";
import type { ExportItemStatus } from "@/lib/export/validation";

/** Serializable row shape handed down from the server (a subset of TalabatPreviewRow). */
export interface TalabatPreviewRowVM {
  internalProductId: string;
  variantId: string | null;
  isVariant: boolean;
  sku: string;
  barcode: string | null;
  title: string;
  price: number | null;
  category: string | null;
  hasImage: boolean;
  imageExportName: string | null;
  inheritedParentImage: boolean;
  mappingStatus: "resolved" | "needs_review" | "unmapped";
  status: ExportItemStatus;
  reasons: { code: ExportReasonCode; blocking: boolean }[];
}

export interface TalabatPreviewVM {
  rows: TalabatPreviewRowVM[];
  summary: { total: number; ready: number; warnings: number; blocked: number; unknown: number; byReason: Record<string, number> };
  counts: { productCount: number; variantCount: number; sellableRowCount: number };
}

const REASON_LABEL: Record<ExportReasonCode, string> = {
  MISSING_SKU: "SKU مفقود",
  DUPLICATE_SKU: "SKU مكرّر",
  MISSING_BARCODE: "باركود مفقود",
  DUPLICATE_BARCODE: "باركود مكرّر",
  INVALID_BARCODE: "صيغة باركود غير قياسية",
  MISSING_IMAGE: "صورة مفقودة",
  IMAGE_SHARED_FROM_PRODUCT: "الصورة مشتركة من المنتج",
  MISSING_TITLE: "عنوان مفقود",
  MISSING_PRICE: "سعر مفقود",
  MISSING_CATEGORY: "فئة مفقودة",
  LIFECYCLE_NOT_ELIGIBLE: "غير مؤهّل (دورة الحياة)",
  IDENTITY_MISSING: "هوية مفقودة",
  IDENTITY_CONFLICT: "تعارض في الهوية",
  IDENTITY_NEEDS_REVIEW: "ربط بحاجة لمراجعة",
  VARIANT_NOT_READY: "متغيّر غير جاهز",
  UNSUPPORTED: "غير مدعوم",
};

const STATUS_LABEL: Record<ExportItemStatus, string> = {
  READY: "جاهز",
  WARNING: "تحذير",
  BLOCKED: "محظور",
  UNKNOWN: "غير معروف",
};

const STATUS_TONE: Record<ExportItemStatus, string> = {
  READY: "bg-emerald-50 text-emerald-700 border-emerald-200",
  WARNING: "bg-amber-50 text-amber-700 border-amber-200",
  BLOCKED: "bg-rose-50 text-rose-700 border-rose-200",
  UNKNOWN: "bg-slate-50 text-slate-600 border-slate-200",
};

const MAPPING_LABEL: Record<TalabatPreviewRowVM["mappingStatus"], string> = {
  resolved: "مربوط",
  needs_review: "بحاجة لمراجعة",
  unmapped: "غير مربوط",
};

type StatusFilter = "ALL" | ExportItemStatus;

export default function TalabatPreview({ vm }: { vm: TalabatPreviewVM }) {
  const [status, setStatus] = useState<StatusFilter>("ALL");
  const [issue, setIssue] = useState<"ALL" | ExportReasonCode>("ALL");
  const [q, setQ] = useState("");

  // Issue types actually present (so the filter never offers an empty bucket).
  const issueTypes = useMemo(() => {
    const keys = Object.keys(vm.summary.byReason) as ExportReasonCode[];
    return keys.filter((k) => (vm.summary.byReason[k] ?? 0) > 0).sort();
  }, [vm.summary.byReason]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return vm.rows.filter((r) => {
      if (status !== "ALL" && r.status !== status) return false;
      if (issue !== "ALL" && !r.reasons.some((x) => x.code === issue)) return false;
      if (needle) {
        const hay = `${r.sku} ${r.title} ${r.barcode ?? ""}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [vm.rows, status, issue, q]);

  const chip = (active: boolean) =>
    `rounded-full border px-3 py-1 text-xs transition-colors ${
      active ? "border-brand bg-brand-light text-brand" : "border-slate-200 bg-white text-muted hover:bg-slate-50"
    }`;

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <SummaryCard value={vm.summary.total} label="إجمالي الصفوف القابلة للبيع" tone="ink" />
        <SummaryCard value={vm.summary.ready} label="جاهز" tone="emerald" />
        <SummaryCard value={vm.summary.warnings} label="تحذير" tone="amber" />
        <SummaryCard value={vm.summary.blocked} label="محظور" tone="rose" />
      </div>
      <p className="text-[11px] text-muted">
        {vm.counts.productCount} منتج · {vm.counts.variantCount} متغيّر · {vm.counts.sellableRowCount} صف قابل للبيع
        (كل متغيّر صف مستقل — لا يوجد صف أب).
      </p>

      {/* Grouped reasons */}
      {issueTypes.length > 0 ? (
        <div className="card space-y-2">
          <div className="text-sm font-semibold text-ink">أسباب حسب النوع</div>
          <div className="flex flex-wrap gap-1.5">
            {issueTypes.map((code) => (
              <span key={code} className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] text-slate-600">
                {REASON_LABEL[code]} · {vm.summary.byReason[code]}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {/* Filters */}
      <div className="card space-y-3">
        <div className="flex flex-wrap gap-1.5">
          {(["ALL", "READY", "WARNING", "BLOCKED"] as StatusFilter[]).map((s) => (
            <button key={s} type="button" onClick={() => setStatus(s)} className={chip(status === s)}>
              {s === "ALL" ? "الكل" : STATUS_LABEL[s]}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={issue}
            onChange={(e) => setIssue(e.target.value as "ALL" | ExportReasonCode)}
            className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-ink"
          >
            <option value="ALL">كل الأنواع</option>
            {issueTypes.map((code) => (
              <option key={code} value={code}>
                {REASON_LABEL[code]}
              </option>
            ))}
          </select>
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="بحث بالـ SKU أو اسم المنتج…"
            className="min-w-[12rem] flex-1 rounded-lg border border-slate-200 bg-white px-3 py-1 text-xs text-ink"
          />
        </div>
        <div className="text-[11px] text-muted">
          يعرض {filtered.length} من {vm.rows.length} صف
        </div>
      </div>

      {/* Table */}
      <div className="card overflow-x-auto p-0">
        <table className="w-full min-w-[720px] text-right text-xs">
          <thead className="border-b border-slate-200 bg-slate-50 text-[11px] text-muted">
            <tr>
              <th className="px-3 py-2 font-medium">SKU</th>
              <th className="px-3 py-2 font-medium">المنتج · المتغيّر</th>
              <th className="px-3 py-2 font-medium">الباركود</th>
              <th className="px-3 py-2 font-medium">السعر</th>
              <th className="px-3 py-2 font-medium">الصورة</th>
              <th className="px-3 py-2 font-medium">الحالة</th>
              <th className="px-3 py-2 font-medium">السبب</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-muted">لا توجد صفوف مطابقة.</td>
              </tr>
            ) : (
              filtered.map((r) => (
                <tr key={`${r.internalProductId}:${r.variantId ?? "-"}`} className="border-b border-slate-100 last:border-0">
                  <td className="px-3 py-2 font-mono text-[11px]" dir="ltr">
                    {r.sku || <span className="text-rose-600">—</span>}
                  </td>
                  <td className="px-3 py-2">
                    <div className="text-ink">{r.title || <span className="text-rose-600">بدون عنوان</span>}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px] text-muted">
                      <span className="rounded bg-slate-100 px-1 py-0.5">{r.isVariant ? "متغيّر" : "منتج بسيط"}</span>
                      <span className="rounded bg-slate-100 px-1 py-0.5">{MAPPING_LABEL[r.mappingStatus]}</span>
                    </div>
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px]" dir="ltr">
                    {r.barcode || <span className="text-rose-600">—</span>}
                  </td>
                  <td className="px-3 py-2" dir="ltr">
                    {r.price === null ? <span className="text-amber-600">—</span> : r.price}
                  </td>
                  <td className="px-3 py-2">
                    {r.hasImage ? (
                      <div className="space-y-0.5">
                        <div className="font-mono text-[10px] text-muted" dir="ltr">{r.imageExportName ?? "—"}</div>
                        {r.inheritedParentImage ? (
                          <div className="text-[10px] text-amber-600">موروثة من المنتج الأب</div>
                        ) : null}
                      </div>
                    ) : (
                      <span className="text-rose-600">مفقودة</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <span className={`inline-block rounded-full border px-2 py-0.5 text-[10px] ${STATUS_TONE[r.status]}`}>
                      {STATUS_LABEL[r.status]}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    {r.reasons.length === 0 ? (
                      <span className="text-emerald-600">—</span>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {r.reasons.map((x, i) => (
                          <span
                            key={`${x.code}:${i}`}
                            className={`rounded px-1.5 py-0.5 text-[10px] ${
                              x.blocking ? "bg-rose-50 text-rose-600" : "bg-amber-50 text-amber-700"
                            }`}
                          >
                            {REASON_LABEL[x.code]}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SummaryCard({ value, label, tone }: { value: number; label: string; tone: "ink" | "emerald" | "amber" | "rose" }) {
  const toneCls: Record<string, string> = {
    ink: "border-slate-200 text-ink",
    emerald: "border-emerald-200 bg-emerald-50 text-emerald-700",
    amber: "border-amber-200 bg-amber-50 text-amber-700",
    rose: "border-rose-200 bg-rose-50 text-rose-700",
  };
  return (
    <div className={`rounded-lg border p-3 text-center ${toneCls[tone]}`}>
      <div className="text-xl font-bold">{value}</div>
      <div className="mt-0.5 text-[10px] text-muted">{label}</div>
    </div>
  );
}
