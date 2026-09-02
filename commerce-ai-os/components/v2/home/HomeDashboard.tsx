// HOME.1 — Executive Home Dashboard (PRESENTATIONAL). A Server Component that
// takes the pre-composed HomeDashboardModel and renders the 12 sections. It holds
// NO data client, issues NO queries and performs NO writes — it only lays out
// certified numbers and links to the existing workflows. UNKNOWN values render as
// an em dash (never fabricated).

import Link from "next/link";
import type {
  HomeDashboardModel,
  HomeStat,
  HomeTextStat,
  HomeTone,
  Maybe,
} from "@/lib/home/home-model";

const UNKNOWN_TEXT = "—";

const TONE: Record<HomeTone, string> = {
  neutral: "border-slate-200 bg-white text-slate-700",
  good: "border-emerald-200 bg-emerald-50 text-emerald-700",
  warn: "border-amber-200 bg-amber-50 text-amber-700",
  bad: "border-rose-200 bg-rose-50 text-rose-700",
};

function fmt(v: Maybe<number>): string {
  return typeof v === "number" && Number.isFinite(v) ? v.toLocaleString("ar-QA") : UNKNOWN_TEXT;
}

function StatCard({ stat }: { stat: HomeStat }) {
  const body = (
    <div className={`rounded-xl border px-3 py-2 ${TONE[stat.tone]}`}>
      <div className="text-lg font-bold">
        {fmt(stat.value)}
        {typeof stat.of === "number" ? (
          <span className="text-xs font-semibold opacity-60"> / {fmt(stat.of)}</span>
        ) : null}
      </div>
      <div className="text-[11px] font-semibold opacity-90">{stat.label}</div>
    </div>
  );
  return stat.href ? (
    <Link href={stat.href} className="block transition hover:opacity-80">
      {body}
    </Link>
  ) : (
    body
  );
}

function TextStatCard({ stat }: { stat: HomeTextStat }) {
  return (
    <div className={`rounded-xl border px-3 py-2 ${stat.available ? TONE.neutral : "border-slate-200 bg-slate-50 text-slate-400"}`}>
      <div className="text-lg font-bold">{stat.value}</div>
      <div className="text-[11px] font-semibold opacity-90">{stat.label}</div>
    </div>
  );
}

function SectionTitle({ children, href, cta }: { children: React.ReactNode; href?: string; cta?: string }) {
  return (
    <div className="mb-2 flex items-center justify-between">
      <h2 className="text-sm font-bold text-slate-700">{children}</h2>
      {href ? (
        <Link href={href} className="text-xs font-semibold text-brand hover:underline" dir="ltr">
          {cta ?? "عرض الكل"} →
        </Link>
      ) : null}
    </div>
  );
}

function Bars({ rows }: { rows: { label: string; count: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div className="space-y-1.5">
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-2 text-xs">
          <span className="w-16 shrink-0 text-slate-500">{r.label}</span>
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
            <div className="h-full rounded-full bg-brand/60" style={{ width: `${Math.round((r.count / max) * 100)}%` }} />
          </div>
          <span className="w-10 shrink-0 text-end font-semibold text-slate-700">{r.count.toLocaleString("ar-QA")}</span>
        </div>
      ))}
    </div>
  );
}

export default function HomeDashboard({ model }: { model: HomeDashboardModel }) {
  const m = model;
  return (
    <div className="space-y-6">
      {/* SECTION 1 — Welcome */}
      <section className="card flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-ink">
            {m.welcome.greeting}
            {m.welcome.ownerName ? ` ${m.welcome.ownerName}` : ""}
          </h1>
          <p className="text-sm text-muted">{m.welcome.dateLabel}</p>
        </div>
        <span className={`rounded-lg border px-3 py-1.5 text-xs font-bold ${TONE[m.welcome.platformStatus.tone]}`}>
          حالة المنصة: {m.welcome.platformStatus.label}
        </span>
      </section>

      {/* SECTION 0 — Launch Readiness (top KPI, HOME.2) */}
      {m.launchReadiness.available ? (
        <section className="card border-brand/30 bg-gradient-to-l from-brand-light/40 to-white">
          <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-sm font-bold text-brand">جاهزية الإطلاق</h2>
              <div className="flex items-end gap-2">
                <span className="text-4xl font-extrabold text-ink">
                  {typeof m.launchReadiness.readinessPct === "number" ? `${m.launchReadiness.readinessPct}%` : UNKNOWN_TEXT}
                </span>
                <span className="pb-1 text-xs text-muted">الهدف {m.launchReadiness.progress.targetPct}%</span>
              </div>
            </div>
            <div className="text-end text-xs text-muted">
              <div>متبقٍّ: <b className="text-ink">{fmt(m.launchReadiness.progress.productsRemaining)}</b> منتج</div>
              <div>بنود تحتاج معالجة: <b className="text-ink">{fmt(m.launchReadiness.progress.estimatedRemainingWork)}</b></div>
            </div>
          </div>
          {typeof m.launchReadiness.progress.currentPct === "number" ? (
            <div className="mb-4 h-2.5 w-full overflow-hidden rounded-full bg-slate-100">
              <div className="h-full rounded-full bg-brand" style={{ width: `${Math.min(100, Math.max(0, m.launchReadiness.progress.currentPct))}%` }} />
            </div>
          ) : null}
          <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
            {m.launchReadiness.headline.map((c) => <StatCard key={c.key} stat={c} />)}
          </div>
          <h3 className="mb-2 text-xs font-bold text-slate-600">ملخّص المعوّقات (اضغط للانتقال)</h3>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
            {m.launchReadiness.blockedSummary.map((c) => <StatCard key={c.key} stat={c} />)}
          </div>
        </section>
      ) : null}

      {/* SECTION 2 — Today's Overview */}
      <section>
        <SectionTitle>نظرة اليوم</SectionTitle>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {m.overview.cards.map((c) => <StatCard key={c.key} stat={c} />)}
        </div>
      </section>

      {/* SECTION 3 — Action Center Summary */}
      <section className="card">
        <SectionTitle href={m.actionCenter.href} cta="مركز الإجراءات">مركز الإجراءات</SectionTitle>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
          {m.actionCenter.cards.map((c) => <StatCard key={c.key} stat={c} />)}
        </div>
      </section>

      {/* SECTION 4 — Catalog Overview */}
      <section className="card">
        <SectionTitle href="/v2/catalog" cta="الكتالوج">نظرة الكتالوج</SectionTitle>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {m.catalog.cards.map((c) => <StatCard key={c.key} stat={c} />)}
        </div>
      </section>

      {/* SECTION 5 — Channel Health */}
      <section>
        <SectionTitle>صحة القنوات</SectionTitle>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {m.channelHealth.channels.map((c) => (
            <Link key={c.key} href={c.href} className="rounded-xl border border-slate-200 bg-white p-3 transition hover:bg-slate-50">
              <div className="flex items-center justify-between">
                <span className="text-sm font-bold text-ink" dir="ltr">{c.label}</span>
                <span className="text-[11px] font-semibold text-slate-500">{c.status}</span>
              </div>
              <div className="mt-2 grid grid-cols-3 gap-1 text-center text-xs">
                <div>
                  <div className="font-bold text-slate-700">
                    {fmt(c.mapped)}
                    {typeof c.masterTotal === "number" ? (
                      <span className="text-[10px] font-semibold text-slate-400"> / {fmt(c.masterTotal)}</span>
                    ) : null}
                  </div>
                  <div className="text-[10px] text-slate-400">مُدرج</div>
                </div>
                <div><div className="font-bold text-slate-700">{fmt(c.blocked)}</div><div className="text-[10px] text-slate-400">ناقص</div></div>
                <div><div className="font-bold text-slate-700">{fmt(c.needsReview)}</div><div className="text-[10px] text-slate-400">مراجعة</div></div>
              </div>
              <div className="mt-1 text-[10px] text-slate-400">
                آخر تصدير: {typeof c.lastExport === "string" ? c.lastExport.slice(0, 10) : UNKNOWN_TEXT}
              </div>
            </Link>
          ))}
          {m.channelHealth.channels.length === 0 ? <p className="text-xs text-muted">{UNKNOWN_TEXT}</p> : null}
        </div>
      </section>

      {/* SECTION 6 — Export Overview */}
      <section className="card">
        <SectionTitle href="/v2/export" cta="مركز التصدير">نظرة التصدير</SectionTitle>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          {m.exportOverview.cards.map((c) => <StatCard key={c.key} stat={c} />)}
        </div>
        {m.exportOverview.runs.length > 0 ? (
          <div className="mt-3 space-y-1 text-xs">
            <div className="font-semibold text-slate-600">آخر عمليات النشر</div>
            {m.exportOverview.runs.slice(0, 5).map((r, i) => (
              <div key={i} className="flex items-center justify-between rounded-lg bg-slate-50 px-2 py-1">
                <span className="text-slate-600">{r.operation} · {r.status}</span>
                <span className="text-slate-400" dir="ltr">{typeof r.finishedAt === "string" ? r.finishedAt.slice(0, 16).replace("T", " ") : UNKNOWN_TEXT}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-2 text-xs text-muted">لا يوجد سجل تصدير متاح ({UNKNOWN_TEXT}).</p>
        )}
      </section>

      {/* SECTION 7 — AI Overview */}
      <section className="card">
        <SectionTitle href="/v2/operations/ai" cta="مركز الذكاء">نظرة الذكاء الاصطناعي</SectionTitle>
        <div className="grid grid-cols-3 gap-2">
          {m.aiOverview.cards.map((c) => <StatCard key={c.key} stat={c} />)}
        </div>
        <div className="mt-2">
          <span className={`inline-block rounded-lg border px-2.5 py-1 text-[11px] font-bold ${TONE[m.aiOverview.provider.tone]}`}>
            المزوّد: {m.aiOverview.provider.label}
          </span>
        </div>
      </section>

      {/* SECTION 8 — Beauty Rewards */}
      <section className="card">
        <SectionTitle href="/v2/loyalty" cta="مكافآت الجمال">مكافآت الجمال</SectionTitle>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          {m.rewards.cards.map((c) => <StatCard key={c.key} stat={c} />)}
        </div>
        {m.rewards.latestRegistrations.length > 0 ? (
          <div className="mt-3 space-y-1 text-xs">
            <div className="font-semibold text-slate-600">أحدث التسجيلات</div>
            {m.rewards.latestRegistrations.map((r, i) => (
              <div key={i} className="flex items-center justify-between rounded-lg bg-slate-50 px-2 py-1">
                <span className="text-slate-700">{r.name}</span>
                <span className="text-slate-400" dir="ltr">{r.phone}</span>
              </div>
            ))}
          </div>
        ) : null}
      </section>

      {/* SECTION 9 — Catalog Intelligence */}
      <section className="card">
        <SectionTitle>ذكاء الكتالوج</SectionTitle>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div>
            <div className="mb-1 flex items-center justify-between text-xs font-semibold text-slate-600">
              <span>توزيع الصحة</span>
              <span className="text-slate-400">متوسط: {fmt(m.intelligence.averageScore)}</span>
            </div>
            {m.intelligence.healthDistribution.length ? <Bars rows={m.intelligence.healthDistribution} /> : <p className="text-xs text-muted">{UNKNOWN_TEXT}</p>}
          </div>
          <div>
            <div className="mb-1 text-xs font-semibold text-slate-600">ملخّص التوصيات</div>
            {m.intelligence.recommendationsByPriority.length ? <Bars rows={m.intelligence.recommendationsByPriority} /> : <p className="text-xs text-muted">{UNKNOWN_TEXT}</p>}
          </div>
          <div>
            <div className="mb-1 text-xs font-semibold text-slate-600">ملخّص الأدلة</div>
            {m.intelligence.evidenceBySeverity.length ? <Bars rows={m.intelligence.evidenceBySeverity} /> : <p className="text-xs text-muted">{UNKNOWN_TEXT}</p>}
          </div>
        </div>
      </section>

      {/* SECTION 10 — Analytics */}
      <section className="card">
        <SectionTitle href="/v2/analytics" cta="التحليلات">التحليلات</SectionTitle>
        {m.analytics.cards.length ? (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {m.analytics.cards.map((c) => <TextStatCard key={c.key} stat={c} />)}
          </div>
        ) : (
          <p className="text-xs text-muted">لا تتوفر بيانات مبيعات ({UNKNOWN_TEXT}).</p>
        )}
        {!m.analytics.configured ? <p className="mt-2 text-[11px] text-slate-400">قيم غير المتوفّرة تظهر كشرطة — لا تُختلق أرقام.</p> : null}
      </section>

      {/* SECTION 11 — Recent Activity */}
      <section className="card">
        <SectionTitle>النشاط الأخير</SectionTitle>
        {m.activity.events.length ? (
          <div className="max-h-80 space-y-1 overflow-y-auto text-xs">
            {m.activity.events.map((e) => (
              <div key={e.id} className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-2 py-1">
                <span className="truncate text-slate-700">
                  {e.type}
                  {typeof e.sku === "string" && e.sku !== "UNKNOWN" ? ` · ${e.sku}` : ""}
                  {typeof e.field === "string" && e.field !== "UNKNOWN" ? ` · ${e.field}` : ""}
                </span>
                <span className="shrink-0 text-slate-400" dir="ltr">{e.at ? e.at.slice(0, 16).replace("T", " ") : UNKNOWN_TEXT}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted">{UNKNOWN_TEXT}</p>
        )}
      </section>

      {/* SECTION 12 — Quick Actions */}
      <section>
        <SectionTitle>إجراءات سريعة</SectionTitle>
        <div className="flex flex-wrap gap-2">
          {m.quickActions.map((a) => (
            <Link key={a.key} href={a.href} className="rounded-lg border border-brand/30 bg-brand-light/40 px-3 py-1.5 text-xs font-semibold text-brand hover:bg-brand-light">
              {a.label}
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
