"use client";

// INT.2B.2 — Talabat package generation controls (client).
//
// Shows the operator-facing PRE-generation preview (§11) computed server-side
// from the certified INT.2B preview, then generates the "Ready" package via the
// writer-gated API route and surfaces the POST-generation summary (§17). It
// holds only view state; it never re-derives a rule and never publishes. The
// "Generate Ready Package" mode packages every NOT-blocked sellable row; blocked
// rows can never be included.

import { useState } from "react";
import type { ExportReasonCode } from "@/lib/export/validation";

export interface TalabatPlanVM {
  products: number;
  sellableRows: number;
  simpleProducts: number;
  variantRows: number;
  ready: number;
  warnings: number;
  blocked: number;
  rowsIncluded: number;
  imagesExpected: number;
  imagesSharedFromProduct: number;
  blockersByReason: Partial<Record<ExportReasonCode, number>>;
}

interface GeneratedSummary {
  filename: string;
  sellableRows: string;
  simpleRows: string;
  variantRows: string;
  images: string;
  sharedImages: string;
  warnings: string;
  excludedBlocked: string;
  excludedNoImage: string;
  generatedAt: string;
  generatedBy: string;
}

const REASON_LABEL: Record<string, string> = {
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
  VARIANT_NOT_READY: "متغيّر غير جاهز",
  UNSUPPORTED: "غير مدعوم",
};

export default function TalabatPackageControls({ plan }: { plan: TalabatPlanVM }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<GeneratedSummary | null>(null);

  const blockerEntries = Object.entries(plan.blockersByReason).filter(([, n]) => (n ?? 0) > 0);

  async function generate() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/export/talabat/package", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "ready" }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        setError(text || "تعذّر توليد الحزمة الآن — الرجاء المحاولة لاحقاً.");
        return;
      }
      const h = res.headers;
      const summary: GeneratedSummary = {
        filename: h.get("X-Talabat-Output-Filename") ?? "talabat-export.zip",
        sellableRows: h.get("X-Talabat-Sellable-Rows") ?? "0",
        simpleRows: h.get("X-Talabat-Simple-Rows") ?? "0",
        variantRows: h.get("X-Talabat-Variant-Rows") ?? "0",
        images: h.get("X-Talabat-Image-Count") ?? "0",
        sharedImages: h.get("X-Talabat-Shared-Image-Count") ?? "0",
        warnings: h.get("X-Talabat-Warning-Count") ?? "0",
        excludedBlocked: h.get("X-Talabat-Excluded-Blocked") ?? "0",
        excludedNoImage: h.get("X-Talabat-Excluded-No-Image") ?? "0",
        generatedAt: h.get("X-Talabat-Generated-At") ?? "",
        generatedBy: h.get("X-Talabat-Generated-By") ?? "",
      };
      // Stream the archive to a download without exposing any filesystem path.
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = summary.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setResult(summary);
    } catch {
      setError("تعذّر الاتصال بالخادم — الرجاء المحاولة لاحقاً.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card space-y-4">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold text-ink">توليد حزمة طلبات</h2>
        <p className="text-[11px] text-muted">
          يتم إنشاء ملف <span dir="ltr">talabat-products.xlsx</span> مع مجلد الصور <span dir="ltr">images/</span> باسم
          الـ SKU لكل صف قابل للبيع (المنتج البسيط صف واحد، وكل متغيّر صف مستقل). الصفوف المحظورة لا تُصدَّر أبداً.
        </p>
      </div>

      {/* Pre-generation preview (§11) */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <PlanCard value={plan.ready} label="جاهز" tone="emerald" />
        <PlanCard value={plan.warnings} label="تحذير" tone="amber" />
        <PlanCard value={plan.blocked} label="محظور (مُستبعَد)" tone="rose" />
        <PlanCard value={plan.rowsIncluded} label="صفوف ستُضمَّن" tone="ink" />
      </div>
      <div className="grid grid-cols-2 gap-2 text-[11px] text-muted sm:grid-cols-4">
        <Stat label="منتجات" value={plan.products} />
        <Stat label="صفوف قابلة للبيع" value={plan.sellableRows} />
        <Stat label="منتجات بسيطة" value={plan.simpleProducts} />
        <Stat label="صفوف متغيّرات" value={plan.variantRows} />
        <Stat label="صور متوقّعة" value={plan.imagesExpected} />
        <Stat label="صور مشتركة من المنتج" value={plan.imagesSharedFromProduct} />
      </div>

      {plan.imagesSharedFromProduct > 0 ? (
        <div className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-[11px] text-sky-800" dir="rtl">
          {plan.imagesSharedFromProduct} صف يستخدم صورة المنتج المشتركة (لا يوجد نموذج صور خاص بالمتغيّرات بعد) —
          هذا للعلم فقط ولا يمنع التصدير. الصور الخاصة بكل متغيّر ستُضاف في مشروع «صور المتغيّرات» لاحقاً.
        </div>
      ) : null}

      {blockerEntries.length > 0 ? (
        <div className="space-y-1">
          <div className="text-[11px] font-semibold text-ink">أسباب الحظر (مُستبعَدة من الحزمة)</div>
          <div className="flex flex-wrap gap-1.5">
            {blockerEntries.map(([code, n]) => (
              <span key={code} className="rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 text-[11px] text-rose-700">
                {REASON_LABEL[code] ?? code} · {n}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={generate}
          disabled={busy || plan.rowsIncluded === 0}
          className="btn-primary disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "جارٍ التوليد…" : "توليد حزمة الجاهزة"}
        </button>
        <button type="button" disabled className="btn-ghost cursor-not-allowed opacity-50" title="غير متاح في هذه المرحلة">
          نشر إلى طلبات (غير متاح)
        </button>
        {plan.rowsIncluded === 0 ? (
          <span className="text-[11px] text-muted">لا توجد صفوف جاهزة للتصدير حالياً.</span>
        ) : null}
      </div>

      {error ? (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700" dir="auto">
          {error}
        </div>
      ) : null}

      {result ? (
        <div className="space-y-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3">
          <div className="text-xs font-semibold text-emerald-800">تم توليد الحزمة وتنزيلها</div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-emerald-900 sm:grid-cols-3">
            <ResultRow label="الملف" value={result.filename} ltr />
            <ResultRow label="الصفوف" value={result.sellableRows} />
            <ResultRow label="المتغيّرات" value={result.variantRows} />
            <ResultRow label="الصور" value={result.images} />
            <ResultRow label="صور مشتركة من المنتج" value={result.sharedImages} />
            <ResultRow label="تحذيرات" value={result.warnings} />
            <ResultRow label="محظور مُستبعَد" value={result.excludedBlocked} />
            <ResultRow label="بلا صورة مُستبعَد" value={result.excludedNoImage} />
            <ResultRow label="وقت التوليد" value={result.generatedAt} ltr />
            <ResultRow label="بواسطة" value={result.generatedBy} ltr />
          </div>
        </div>
      ) : null}
    </section>
  );
}

function PlanCard({ value, label, tone }: { value: number; label: string; tone: "ink" | "emerald" | "amber" | "rose" }) {
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

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-slate-200 px-2 py-1.5 text-center">
      <div className="text-sm font-semibold text-ink">{value}</div>
      <div className="text-[10px] text-muted">{label}</div>
    </div>
  );
}

function ResultRow({ label, value, ltr }: { label: string; value: string; ltr?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-emerald-700">{label}</span>
      <span className="font-mono" dir={ltr ? "ltr" : undefined}>{value || "—"}</span>
    </div>
  );
}
