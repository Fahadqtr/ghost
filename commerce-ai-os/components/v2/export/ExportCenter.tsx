// INT.2A — Export Center dashboard (presentational, read-only Server Component).
// Renders one card per canonical destination from the pure composer's model. No
// client JS, no actions — every value already computed server-side; UNKNOWN is
// shown honestly (never a fabricated count/date).

import Link from "next/link";
import type { DestinationCardVM, ExportCenterModel, Unknownable } from "@/lib/export/export-center";

function num(v: Unknownable<number>): string {
  return v === "UNKNOWN" ? "غير معروف" : String(v);
}
function when(v: Unknownable<string>): string {
  return v === "UNKNOWN" || !v ? "غير معروف" : v;
}

const GRAIN_LABEL: Record<string, string> = {
  product: "منتج",
  variant: "متغيّر (قابل للبيع)",
};

function DestinationCard({ d }: { d: DestinationCardVM }) {
  return (
    <Link href={d.detailHref} className="card space-y-3 transition-colors hover:shadow-md">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-sm font-semibold text-ink">{d.label}</div>
          <div className="mt-0.5 text-[11px] text-muted" dir="ltr">{d.key}</div>
        </div>
        <span
          className={
            d.operationalState === "ADAPTER_READY"
              ? "rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] text-emerald-700"
              : "rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] text-slate-600"
          }
        >
          {d.operationalState === "ADAPTER_READY"
            ? "المُحوِّل جاهز"
            : d.operationalState === "FOUNDATION_READY"
              ? "الأساس جاهز"
              : "غير معروف"}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-2 text-center text-xs">
        <div className="rounded-lg border border-slate-200 p-2">
          <div className="font-bold text-ink">{num(d.productsEligible)}</div>
          <div className="mt-0.5 text-[10px] text-muted">مؤهّل</div>
        </div>
        <div className="rounded-lg border border-slate-200 p-2">
          <div className="font-bold text-ink">{num(d.productsBlocked)}</div>
          <div className="mt-0.5 text-[10px] text-muted">محظور</div>
        </div>
        <div className="rounded-lg border border-slate-200 p-2">
          <div className="font-bold text-ink">{num(d.warnings)}</div>
          <div className="mt-0.5 text-[10px] text-muted">تنبيهات</div>
        </div>
      </div>

      <div className="flex flex-wrap gap-1">
        <span className="rounded-full bg-brand-light px-2 py-0.5 text-[10px] text-brand">
          {GRAIN_LABEL[d.listingGrain] ?? d.listingGrain}
        </span>
        {d.capabilities.map((c) => (
          <span key={c} className="rounded-full border border-slate-200 px-2 py-0.5 text-[10px] text-muted">
            {c}
          </span>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-2 text-[10px] text-muted">
        <div>آخر تحقق: {when(d.lastValidation)}</div>
        <div>آخر تصدير: {when(d.lastExport)}</div>
        <div>آخر نشر: {when(d.lastPublish)}</div>
      </div>

      <div className="text-left text-[11px] font-semibold text-brand">عرض التفاصيل ↗</div>
    </Link>
  );
}

export default function ExportCenter({ model }: { model: ExportCenterModel }) {
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h1 className="font-serif text-2xl font-semibold text-ink">مركز التصدير</h1>
        <p className="text-sm text-muted">
          نقطة موحّدة لتصدير ونشر المنتجات على المنصات — أساس القراءة فقط في هذه المرحلة.
        </p>
      </div>

      {/* Global catalog-readiness baseline (reused operations readiness), shown once. */}
      <div className="card">
        <div className="mb-2 text-sm font-semibold text-ink">جاهزية الكتالوج (أساس عام)</div>
        <div className="grid grid-cols-2 gap-2 text-center">
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-2">
            <div className="text-lg font-bold text-emerald-700">{num(model.readinessBaseline.eligible)}</div>
            <div className="mt-0.5 text-[11px] text-muted">مؤهّل للتصدير (مكتمل ومعتمد)</div>
          </div>
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-2">
            <div className="text-lg font-bold text-amber-700">{num(model.readinessBaseline.blocked)}</div>
            <div className="mt-0.5 text-[11px] text-muted">غير مؤهّل بعد</div>
          </div>
        </div>
        <p className="mt-2 text-[11px] text-muted">
          الأرقام لكل وجهة (مؤهّل/محظور) تُحسب بقواعد الوجهة في مرحلة لاحقة — تظهر «غير معروف» حالياً.
          سِجل التصدير غير متوفّر بعد (لا يوجد مصدر دائم).
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {model.destinations.map((d) => (
          <DestinationCard key={d.key} d={d} />
        ))}
      </div>
    </div>
  );
}
