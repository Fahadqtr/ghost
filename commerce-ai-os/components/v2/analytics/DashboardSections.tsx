// BI.2 — Executive Dashboard operational sections (PRESENTATIONAL). Compact,
// read-only summaries of the certified OPS read models — Channel Overview (OPS.3),
// Platform Health + Alerts (OPS.6) — each deep-linking to its full workflow. No
// data client, no queries, no writes, no "Fix All". UNKNOWN counts render as an em
// dash, never a fabricated zero.

import Link from "next/link";
import type { StorefrontCard, StorefrontStatus } from "@/lib/operations/channels/channel-center";
import { STOREFRONT_STATUS_LABEL } from "@/lib/operations/channels/channel-center";
import type { DomainStatus, DomainHealth, HealthFinding, HealthCenterModel } from "@/lib/operations/health/health-center";
import { DOMAIN_STATUS_LABEL, DOMAIN_LABEL, ROUTES as HEALTH_ROUTES } from "@/lib/operations/health/health-center";

const CHANNELS_ROUTE = "/v2/operations/channels";

const STATUS_TONE: Record<StorefrontStatus | DomainStatus, string> = {
  HEALTHY: "border-emerald-200 bg-emerald-50 text-emerald-700",
  WARNING: "border-amber-200 bg-amber-50 text-amber-700",
  ACTION_REQUIRED: "border-rose-200 bg-rose-50 text-rose-700",
  OPERATIONALLY_BLOCKED: "border-slate-300 bg-slate-100 text-slate-600",
  UNKNOWN: "border-slate-200 bg-slate-50 text-slate-500",
};

const num = (n: number | null): string => (n == null ? "—" : String(n));

// ── §5 Channel Overview ───────────────────────────────────────────────────────
export function ChannelOverview({ cards, degraded }: { cards: StorefrontCard[]; degraded?: boolean }) {
  return (
    <section className="card space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-bold text-slate-800">نظرة القنوات</h2>
        <Link href={CHANNELS_ROUTE} className="text-xs text-slate-500 hover:text-slate-700">
          مركز القنوات ↗
        </Link>
      </div>
      {degraded && <p className="text-[11px] text-amber-600">بعض إشارات القنوات غير متاحة الآن — تُعرض الحالة المعروفة فقط.</p>}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((c) => (
          <div key={c.key} className={`rounded-xl border p-3 ${STATUS_TONE[c.status]}`}>
            <div className="flex items-start justify-between gap-2">
              <div className="text-sm font-bold">{c.label}</div>
              <span className="shrink-0 rounded-lg border border-current/20 bg-white/60 px-2 py-0.5 text-[11px] font-bold">
                {STOREFRONT_STATUS_LABEL[c.status]}
              </span>
            </div>
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
              <span className="rounded bg-white/50 px-1.5 py-0.5">مربوط: <span className="font-bold">{num(c.mapped)}</span></span>
              <span className="rounded bg-white/50 px-1.5 py-0.5">للمراجعة: <span className="font-bold">{num(c.needsReview)}</span></span>
              {c.operational && (
                <span className="rounded bg-white/50 px-1.5 py-0.5">
                  الحالة التشغيلية: <span className="font-bold">{c.operational.state}</span>
                </span>
              )}
            </div>
            <div className="mt-1 text-[10px] opacity-70">
              {c.stale ? "قد تكون البيانات قديمة · " : ""}
              آخر تحديث: {c.lastSyncAt ?? "—"}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

// ── §8 Health Summary + §9 Alerts ─────────────────────────────────────────────
function DomainBadge({ d }: { d: DomainHealth }) {
  return (
    <span className={`rounded-lg border px-2 py-1 text-[11px] font-semibold ${STATUS_TONE[d.status]}`}>
      {d.label}: {DOMAIN_STATUS_LABEL[d.status]}
    </span>
  );
}

function AlertRow({ f }: { f: HealthFinding }) {
  const tone = f.severity === "action" ? "border-rose-200 bg-rose-50 text-rose-700" : "border-amber-200 bg-amber-50 text-amber-700";
  return (
    <li>
      <Link href={f.href} className={`flex items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-xs ${tone}`}>
        <span>
          <span className="font-semibold">[{DOMAIN_LABEL[f.domain]}]</span> {f.reason}
          {f.count !== null ? <span className="opacity-80"> — {f.count}</span> : null}
        </span>
        <span className="opacity-70">{f.workflow} ↗</span>
      </Link>
    </li>
  );
}

export function HealthAndAlerts({ model, degraded }: { model: HealthCenterModel; degraded?: boolean }) {
  const alerts = model.findings;
  return (
    <section className="card space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-bold text-slate-800">صحة المنصّة والتنبيهات</h2>
        <Link href={HEALTH_ROUTES.health ?? "/v2/operations/health"} className="text-xs text-slate-500 hover:text-slate-700">
          مركز الصحة ↗
        </Link>
      </div>
      {degraded && <p className="text-[11px] text-amber-600">بعض إشارات الصحة غير متاحة الآن — تُعرض الحالة المعروفة فقط.</p>}
      <div className="flex flex-wrap gap-2">
        {model.domains.map((d) => (
          <DomainBadge key={d.key} d={d} />
        ))}
      </div>
      <div>
        <div className="mb-1 text-[11px] font-semibold text-muted">التنبيهات القابلة للتنفيذ</div>
        {alerts.length === 0 ? (
          <p className="text-xs text-slate-500">لا توجد تنبيهات حالية.</p>
        ) : (
          <ul className="space-y-1">
            {alerts.map((f, i) => (
              <AlertRow key={`${f.domain}-${i}`} f={f} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

// ── KPI-header Platform Health chip ───────────────────────────────────────────
export function PlatformHealthChip({ status }: { status: DomainStatus }) {
  return (
    <Link href={HEALTH_ROUTES.health ?? "/v2/operations/health"} className={`rounded-xl border p-3 ${STATUS_TONE[status]}`}>
      <div className="text-[11px] font-semibold opacity-80">صحة المنصّة</div>
      <div className="mt-1 text-lg font-bold">{DOMAIN_STATUS_LABEL[status]}</div>
    </Link>
  );
}
