// CAT.1A — read-only Catalog Health card (presentational). Shows the certified
// per-product score, grade, domain breakdown, and evidence. NO actions, no
// mutation, no data fetching — it renders a CatalogHealth the server already
// computed via loadCatalogHealth.

import type { CatalogHealth, HealthStatus, HealthGrade, HealthDomain } from "@/lib/catalog/health/health-model";

const GRADE_TONE: Record<HealthGrade, string> = {
  Excellent: "bg-emerald-100 text-emerald-800 border-emerald-200",
  Good: "bg-lime-100 text-lime-800 border-lime-200",
  Fair: "bg-amber-100 text-amber-800 border-amber-200",
  Poor: "bg-orange-100 text-orange-800 border-orange-200",
  Critical: "bg-rose-100 text-rose-800 border-rose-200",
};

const STATUS_TONE: Record<HealthStatus, string> = {
  PASS: "bg-emerald-50 text-emerald-700 border-emerald-200",
  WARNING: "bg-amber-50 text-amber-700 border-amber-200",
  FAIL: "bg-rose-50 text-rose-700 border-rose-200",
  UNKNOWN: "bg-slate-50 text-slate-500 border-slate-200",
};

const DOMAIN_LABEL: Record<HealthDomain, string> = {
  images: "الصور", description_ar: "الوصف العربي", description_en: "الوصف الإنجليزي",
  keywords_ar: "كلمات مفتاحية (ع)", keywords_en: "كلمات مفتاحية (EN)", barcode: "الباركود",
  sku: "SKU", brand: "البراند", category: "الفئة", price: "السعر", lifecycle: "دورة الحياة",
  inventory: "المخزون", availability: "التوفّر", ecl: "ربط ECL", channel: "القنوات",
  ai_readiness: "جاهزية الذكاء", export_readiness: "جاهزية التصدير",
};

export default function CatalogHealthCard({ health }: { health: CatalogHealth }) {
  return (
    <div className="card space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-ink">صحة المنتج</h3>
          <p className="text-xs text-muted">درجة محسوبة بقواعد صريحة — للقراءة فقط، بلا أي تعديل.</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-3xl font-bold tabular-nums text-ink" aria-label="score">{health.score}<span className="text-base text-muted">/100</span></div>
          <span className={`rounded-full border px-3 py-1 text-xs font-semibold ${GRADE_TONE[health.grade]}`}>{health.grade}</span>
        </div>
      </div>

      {/* Domain breakdown */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {health.domains.map((d) => (
          <div key={d.domain} className={`flex items-center justify-between rounded-lg border px-2 py-1 text-xs ${STATUS_TONE[d.status]}`}>
            <span className="truncate">{DOMAIN_LABEL[d.domain]}</span>
            <span className="font-semibold">{d.status}</span>
          </div>
        ))}
      </div>

      {/* CAT.1B — explanations live in the unified Evidence section below; the
          card shows the score, grade, and domain breakdown only (no duplicated
          explanation logic). */}
      <p className="text-xs text-muted">التفاصيل والأدلة في قسم «الأدلة» أدناه.</p>
    </div>
  );
}
