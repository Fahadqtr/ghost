// OPS.6 — Platform Health Center (PRESENTATIONAL). A Server Component: it renders
// the pre-composed, read-only health model — overall state, nine domain cards, and
// actionable findings that deep-link to the EXISTING workflows. It holds NO data
// client, issues NO queries and performs NO writes; filters are GET links (no
// client JS), so views are shareable.

import Link from "next/link";
import type {
  DomainStatus,
  DomainHealth,
  HealthFinding,
  HealthCenterModel,
  HealthFilters,
} from "@/lib/operations/health/health-center";
import {
  DOMAIN_STATUS_LABEL,
  DOMAIN_ORDER,
  DOMAIN_LABEL,
  ROUTES,
} from "@/lib/operations/health/health-center";

const STATUS_TONE: Record<DomainStatus, string> = {
  HEALTHY: "border-emerald-200 bg-emerald-50 text-emerald-700",
  WARNING: "border-amber-200 bg-amber-50 text-amber-700",
  ACTION_REQUIRED: "border-rose-200 bg-rose-50 text-rose-700",
  OPERATIONALLY_BLOCKED: "border-slate-300 bg-slate-100 text-slate-600",
  UNKNOWN: "border-slate-200 bg-slate-50 text-slate-500",
};
const SEVERITY_TONE: Record<"warning" | "action", string> = {
  action: "border-rose-200 bg-rose-50 text-rose-700",
  warning: "border-amber-200 bg-amber-50 text-amber-700",
};

function DomainCard({ d }: { d: DomainHealth }) {
  return (
    <div className={`rounded-xl border p-3 ${STATUS_TONE[d.status]}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="text-sm font-bold">{d.label}</div>
        <span className="shrink-0 rounded-lg border border-current/20 bg-white/60 px-2 py-0.5 text-[11px] font-bold">
          {DOMAIN_STATUS_LABEL[d.status]}
        </span>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
        {d.metrics.map((mt) => (
          <span key={mt.label} className="rounded bg-white/50 px-1.5 py-0.5">
            {mt.label}: <span className="font-bold">{mt.value === null ? "—" : mt.value}</span>
          </span>
        ))}
      </div>
      {d.reasons.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-[11px] opacity-90">
          {d.reasons.map((r) => (
            <li key={r}>• {r}</li>
          ))}
        </ul>
      )}
      {d.note && <p className="mt-2 text-[10px] opacity-70">{d.note}</p>}
    </div>
  );
}

function FindingRow({ f }: { f: HealthFinding }) {
  return (
    <li>
      <Link href={f.href} className={`flex items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-xs ${SEVERITY_TONE[f.severity]}`}>
        <span>
          <span className="font-semibold">[{DOMAIN_LABEL[f.domain]}]</span> {f.reason}
          {f.count !== null ? <span className="opacity-80"> — {f.count}</span> : null}
        </span>
        <span className="opacity-70">{f.workflow} ↗</span>
      </Link>
    </li>
  );
}

function activeFilterList(filters: HealthFilters): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  if (filters.domain) out.push({ key: "domain", value: filters.domain });
  if (filters.severity) out.push({ key: "severity", value: filters.severity });
  if (filters.storefront) out.push({ key: "storefront", value: filters.storefront });
  if (filters.brand) out.push({ key: "brand", value: filters.brand });
  if (filters.category) out.push({ key: "category", value: filters.category });
  if (filters.issue) out.push({ key: "issue", value: filters.issue });
  return out;
}

export default function PlatformHealthCenter({
  model,
  findings,
  filters,
  degraded,
}: {
  model: HealthCenterModel;
  findings: HealthFinding[];
  filters: HealthFilters;
  degraded: boolean;
}) {
  const active = activeFilterList(filters);
  const domains = filters.domain ? model.domains.filter((d) => d.key === filters.domain) : model.domains;
  return (
    <section className="space-y-4">
      {degraded && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700" role="status">
          بعض المصادر تعذّرت قراءتها — بعض الإشارات قد تكون غير مكتملة (تظهر «—»، لا تُعتبر سليمة).
        </div>
      )}

      {/* Overall */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-bold text-slate-700">صحة المنصّة</h2>
          <p className="text-[11px] text-muted">
            {model.counts.domains} مجالات · {model.counts.findings} بند · {model.counts.actionRequired} إجراء مطلوب · {model.counts.blocked} معطّل
          </p>
        </div>
        <span className={`rounded-lg border px-2.5 py-1 text-xs font-bold ${STATUS_TONE[model.overall.status]}`}>
          الحالة العامة: {DOMAIN_STATUS_LABEL[model.overall.status]}
          {model.overall.reasons.length > 0 ? <span className="opacity-70"> · {model.overall.reasons.join("، ")}</span> : null}
        </span>
      </div>

      {/* Domain / severity filter chips (GET links) */}
      <div className="flex flex-wrap gap-1.5">
        {DOMAIN_ORDER.map((k) => (
          <Link key={k} href={`${ROUTES.health}?domain=${k}`} className="rounded-lg border border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-50">
            {DOMAIN_LABEL[k]}
          </Link>
        ))}
        <Link href={`${ROUTES.health}?severity=action`} className="rounded-lg border border-rose-200 px-2 py-1 text-[11px] font-semibold text-rose-700 hover:bg-rose-50">إجراء مطلوب</Link>
        <Link href={`${ROUTES.health}?severity=warning`} className="rounded-lg border border-amber-200 px-2 py-1 text-[11px] font-semibold text-amber-700 hover:bg-amber-50">تحذير</Link>
        {active.length > 0 && <Link href={ROUTES.health} className="rounded-lg border border-slate-200 px-2 py-1 text-[11px] font-semibold text-sky-700 hover:bg-slate-50">مسح ✕</Link>}
      </div>

      {/* Domain cards */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {domains.map((d) => (
          <DomainCard key={d.key} d={d} />
        ))}
      </div>

      {/* Actionable findings */}
      <div className="card space-y-2">
        <h2 className="text-sm font-bold text-slate-700">بنود قابلة للتنفيذ</h2>
        {findings.length === 0 ? (
          <p className="text-xs text-muted">لا بنود مطابقة — كل شيء على ما يرام.</p>
        ) : (
          <ul className="space-y-1.5">
            {findings.map((f, i) => (
              <FindingRow key={`${f.domain}:${f.reason}:${i}`} f={f} />
            ))}
          </ul>
        )}
        <p className="text-[10px] text-muted">
          لا يوجد «إصلاح شامل» — كل بند يوجّه إلى مسار العمل المعتمد. الفحوص العميقة (تسوية المخزون، تكرار/يتم ECL، الصور
          المكسورة) عند الطلب. سجل الصحة التاريخي مؤجّل (لا يُنشأ سجل جديد).
        </p>
      </div>
    </section>
  );
}
