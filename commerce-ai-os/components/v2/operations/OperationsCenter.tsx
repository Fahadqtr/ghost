// OPS.1 — Operations Center header (PRESENTATIONAL). A Server Component: it takes
// the pre-composed model (built server-side from data the page already loads) and
// renders daily summary, health cards, channel health, alerts and quick-action
// links. It holds NO data client, issues NO queries, and performs NO writes — it
// only orchestrates navigation to the existing workflows.

import Link from "next/link";
import type {
  OperationsCenterModel,
  DomainStatus,
  CardTone,
  AlertLevel,
} from "@/lib/operations/ops-center";
import { DOMAIN_STATUS_LABEL } from "@/lib/operations/ops-center";

const STATUS_TONE: Record<DomainStatus, string> = {
  PASS: "border-emerald-200 bg-emerald-50 text-emerald-700",
  WARNING: "border-amber-200 bg-amber-50 text-amber-700",
  ACTION_REQUIRED: "border-rose-200 bg-rose-50 text-rose-700",
};
const CARD_TONE: Record<CardTone, string> = {
  neutral: "border-slate-200 bg-white text-slate-700",
  good: "border-emerald-200 bg-emerald-50 text-emerald-700",
  warn: "border-amber-200 bg-amber-50 text-amber-700",
  bad: "border-rose-200 bg-rose-50 text-rose-700",
};
const ALERT_TONE: Record<AlertLevel, string> = {
  info: "border-sky-200 bg-sky-50 text-sky-700",
  warning: "border-amber-200 bg-amber-50 text-amber-700",
  action: "border-rose-200 bg-rose-50 text-rose-700",
};

export default function OperationsCenter({ model }: { model: OperationsCenterModel }) {
  return (
    <section className="space-y-4">
      {/* Daily summary */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold text-slate-700">حالة اليوم</h2>
          <span className={`rounded-lg border px-2.5 py-1 text-xs font-bold ${STATUS_TONE[model.overall]}`}>
            الحالة العامة: {DOMAIN_STATUS_LABEL[model.overall]}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {model.daily.map((d) => (
            <div key={d.domain} className={`rounded-xl border px-3 py-2 ${STATUS_TONE[d.status]}`}>
              <div className="text-xs font-bold">{d.domain}</div>
              <div className="text-[11px] font-semibold opacity-90">{DOMAIN_STATUS_LABEL[d.status]}</div>
              <div className="text-[10px] opacity-70">{d.note}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Quick actions */}
      <div className="flex flex-wrap gap-2">
        {model.quickActions.map((a) => (
          <Link
            key={a.key}
            href={a.href}
            className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
          >
            {a.label} ↗
          </Link>
        ))}
      </div>

      {/* Health cards */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-9">
        {model.cards.map((c) => (
          <Link key={c.key} href={c.href} className={`rounded-xl border px-3 py-2 text-center transition hover:brightness-95 ${CARD_TONE[c.tone]}`}>
            <div className="text-lg font-bold">{c.value === null ? "↗" : c.value}</div>
            <div className="text-[11px] font-medium opacity-80">{c.label}</div>
          </Link>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Channel health */}
        <div className="card space-y-2">
          <h2 className="text-sm font-bold text-slate-700">صحة القنوات</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-slate-400">
                  <th className="px-2 py-1 text-start font-medium">الواجهة</th>
                  <th className="px-2 py-1 text-center font-medium">مرتبط</th>
                  <th className="px-2 py-1 text-center font-medium">يحتاج ربط</th>
                  <th className="px-2 py-1 text-center font-medium">مراجعة</th>
                  <th className="px-2 py-1 text-center font-medium">الحالة</th>
                </tr>
              </thead>
              <tbody>
                {model.channels.map((ch) => (
                  <tr key={ch.storefront} className="border-t border-slate-100">
                    <td className="px-2 py-1.5 font-medium text-slate-700">
                      {/* OPS.7 — deep-link the storefront to its filtered Missing-Products resolver. */}
                      <Link href={ch.href} className="text-sky-700 hover:underline">
                        {ch.label} ↗
                      </Link>
                    </td>
                    <td className="px-2 py-1.5 text-center">{ch.operationalBlocked ? "—" : ch.mapped}</td>
                    <td className="px-2 py-1.5 text-center">{ch.operationalBlocked ? "—" : ch.needsMapping}</td>
                    <td className="px-2 py-1.5 text-center">{ch.operationalBlocked ? "—" : ch.needsReview}</td>
                    <td className="px-2 py-1.5 text-center">
                      {ch.operationalBlocked ? (
                        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">غير مُفعّل</span>
                      ) : (
                        <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] text-emerald-700">نشط</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Alerts */}
        <div className="card space-y-2">
          <h2 className="text-sm font-bold text-slate-700">التنبيهات</h2>
          {model.alerts.length === 0 ? (
            <p className="text-xs text-muted">لا تنبيهات — كل شيء على ما يرام.</p>
          ) : (
            <ul className="space-y-1.5">
              {model.alerts.map((a) => (
                <li key={a.key}>
                  <Link href={a.href} className={`flex items-center justify-between rounded-lg border px-2.5 py-1.5 text-xs ${ALERT_TONE[a.level]}`}>
                    <span>{a.message}</span>
                    <span className="opacity-70">↗</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
