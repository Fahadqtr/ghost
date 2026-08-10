// Malikas V2 Operations — Platform Freshness & Health strip (CI.4). Server
// Component: NO business logic and NO branching on platform name — it renders
// PlatformHealth rows already computed by lib/operations/platform-health, using
// that module's own label + tone maps. Arabic RTL, mobile-first, no client JS.

import {
  FRESHNESS_LABELS,
  FRESHNESS_TONE,
  HEALTH_LEVEL_LABELS,
  HEALTH_LEVEL_TONE,
  HEALTH_REASON_LABELS,
  type PlatformHealth,
} from "@/lib/operations/platform-health";

function HealthCard({ h }: { h: PlatformHealth }) {
  const insufficient = h.healthLevel === "insufficient_data";
  return (
    <div className="card space-y-2 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-ink">{h.label}</span>
        <span className={"rounded-full px-2 py-0.5 text-[10px] " + HEALTH_LEVEL_TONE[h.healthLevel]}>
          {HEALTH_LEVEL_LABELS[h.healthLevel]}
        </span>
      </div>

      <div className="flex items-center justify-between text-[11px]">
        <span className="text-muted">الحداثة</span>
        <span className={"rounded-full px-2 py-0.5 text-[10px] " + FRESHNESS_TONE[h.freshnessState]}>
          {FRESHNESS_LABELS[h.freshnessState]}
        </span>
      </div>

      <p className="text-[10px] text-muted">
        آخر لقطة: {h.lastSnapshotAt ? new Date(h.lastSnapshotAt).toLocaleString("ar") : "—"}
      </p>

      {insufficient ? (
        <p className="text-[11px] text-muted">بيانات غير كافية — لا تُحتسب المنتجات كغير موجودة.</p>
      ) : null}

      {h.reasons.length > 0 ? (
        <ul className="flex flex-wrap gap-1">
          {h.reasons.map((r) => (
            <li key={r} className="rounded-full bg-[#faf3ec] px-2 py-0.5 text-[10px] text-muted">
              {HEALTH_REASON_LABELS[r]}
            </li>
          ))}
        </ul>
      ) : !insufficient ? (
        <p className="text-[11px] text-emerald-700">لا توجد ملاحظات.</p>
      ) : null}
    </div>
  );
}

export default function PlatformHealthSection({ health }: { health: PlatformHealth[] }) {
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold text-ink">صحة المنصات وحداثة البيانات</h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {health.map((h) => (
          <HealthCard key={h.platform} h={h} />
        ))}
      </div>
    </section>
  );
}
