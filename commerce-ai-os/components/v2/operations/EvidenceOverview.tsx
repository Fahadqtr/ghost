// CAT.1B — read-only Evidence overview (presentational). Counts by severity,
// domain, and source across the catalog. No actions, no fetching.

import type { EvidenceOverview } from "@/lib/catalog/evidence/evidence-engine";

function CountRow({ label, n, max }: { label: string; n: number; max: number }) {
  return (
    <li className="flex items-center gap-3 text-xs">
      <span className="w-28 shrink-0 truncate text-ink">{label}</span>
      <span className="h-2 flex-1 overflow-hidden rounded bg-slate-100">
        <span className="block h-full bg-slate-400" style={{ width: `${Math.round((n / Math.max(1, max)) * 100)}%` }} />
      </span>
      <span className="w-12 shrink-0 text-right font-semibold tabular-nums text-ink">{n}</span>
    </li>
  );
}

export default function EvidenceOverview({ overview }: { overview: EvidenceOverview }) {
  const sev = overview.bySeverity;
  const domains = Object.entries(overview.byDomain).sort((a, b) => b[1] - a[1]);
  const sources = Object.entries(overview.bySource).sort((a, b) => b[1] - a[1]);
  const domMax = Math.max(1, ...domains.map(([, n]) => n));
  const srcMax = Math.max(1, ...sources.map(([, n]) => n));

  return (
    <div className="card space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-ink">نظرة عامة على الأدلة</h3>
        <span className="text-xs text-muted">{overview.total} دليل · {overview.productsWithEvidence} منتج</span>
      </div>
      <p className="text-xs text-muted">للقراءة فقط — كل دليل يأتي من قاعدة معتمدة (لا شيء مُختلق).</p>
      <div className="flex flex-wrap gap-2 text-xs">
        <span className="rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 text-rose-700">حرِج {sev.CRITICAL}</span>
        <span className="rounded-full border border-orange-200 bg-orange-50 px-2 py-0.5 text-orange-700">خطأ {sev.ERROR}</span>
        <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-amber-700">تحذير {sev.WARNING}</span>
        <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-slate-600">معلومة {sev.INFO}</span>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <h4 className="mb-1 text-xs font-semibold text-muted">حسب المجال</h4>
          <ul className="space-y-1.5">{domains.map(([d, n]) => <CountRow key={d} label={d} n={n} max={domMax} />)}</ul>
        </div>
        <div>
          <h4 className="mb-1 text-xs font-semibold text-muted">حسب المصدر</h4>
          <ul className="space-y-1.5">{sources.map(([s, n]) => <CountRow key={s} label={s} n={n} max={srcMax} />)}</ul>
        </div>
      </div>
    </div>
  );
}
