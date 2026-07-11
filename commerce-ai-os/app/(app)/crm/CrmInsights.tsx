import type { CrmStats } from "./actions";
import { formatQar } from "@/lib/social/ad-overlay-compute";

// At-a-glance customer numbers on top of the CRM directory: revenue, average
// order, buyers vs leads, and the top spenders. Read-only, server-rendered.
export default function CrmInsights({ stats, locale = "ar" }: { stats: CrmStats; locale?: string }) {
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);
  const money = (v: number) => (stats.currency === "QAR" ? formatQar(Math.round(v)) : `${Math.round(v)} ${stats.currency}`);

  const kpis = [
    { label: L("الإيرادات", "Revenue"), value: money(stats.revenue), icon: "💰" },
    { label: L("متوسط الطلب", "Avg order"), value: money(stats.avgOrder), icon: "🧾" },
    { label: L("مشترون", "Buyers"), value: String(stats.buyers), icon: "🛍️" },
    { label: L("جهات دايركت", "Leads"), value: String(stats.leads), icon: "💬" },
  ];

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {kpis.map((k) => (
          <div key={k.label} className="rounded-xl border border-[#efe3d6] bg-white p-3">
            <div className="text-lg" aria-hidden="true">{k.icon}</div>
            <div className="mt-1 text-lg font-bold text-ink tabular-nums">{k.value}</div>
            <div className="text-[11px] text-muted">{k.label}</div>
          </div>
        ))}
      </div>

      {stats.top.length ? (
        <div className="rounded-xl border border-[#efe3d6] bg-white p-3">
          <p className="mb-2 text-xs font-semibold text-muted">👑 {L("أفضل العملاء", "Top customers")}</p>
          <ol className="space-y-1.5">
            {stats.top.map((c, i) => (
              <li key={i} className="flex items-center gap-2 text-sm">
                <span className="w-4 shrink-0 text-center text-xs font-bold text-amber-600 tabular-nums">{i + 1}</span>
                <span className="min-w-0 flex-1 truncate text-ink">{c.name}</span>
                <span className="shrink-0 text-[11px] text-muted tabular-nums">{c.orders} {L("طلب", "ord")}</span>
                <span className="shrink-0 font-semibold text-ink tabular-nums">{money(c.spent)}</span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </div>
  );
}
