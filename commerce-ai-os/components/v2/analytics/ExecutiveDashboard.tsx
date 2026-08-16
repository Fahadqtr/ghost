// BI.2 — Executive Dashboard (PRESENTATIONAL). A Server Component that renders the
// pre-composed, read-only analytics view model: the KPI header, Sales Overview,
// Inventory Overview, Catalog Quality, the Operations Summary queue cards and the
// dashboard search. It holds NO data client, issues NO queries and performs NO
// writes. The heavier operational widgets (Channel Overview, Health + Alerts) are
// streamed in by the page via Suspense and passed as slots. UNKNOWN values render
// as an em dash — never a fabricated zero.

import type { ReactNode } from "react";
import Link from "next/link";
import type {
  ExecutiveDashboardView,
  KpiCard,
  StatCell,
  CatalogQualityCell,
  QueueCardView,
  SalesRowView,
  SearchField,
} from "@/lib/analytics/executive-dashboard";

const UNKNOWN_TONE = "text-slate-400";

function KpiTile({ c }: { c: KpiCard }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3">
      <div className="text-[11px] font-semibold text-muted">{c.label}</div>
      <div className={`mt-1 text-lg font-bold ${c.status === "unknown" ? UNKNOWN_TONE : "text-slate-800"}`}>{c.value}</div>
      {c.hint && <div className="mt-0.5 text-[10px] text-slate-400">{c.hint}</div>}
    </div>
  );
}

function StatTile({ c }: { c: StatCell }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
      <div className="text-[11px] text-muted">{c.label}</div>
      <div className={`text-base font-bold ${c.status === "unknown" ? UNKNOWN_TONE : "text-slate-800"}`}>{c.value}</div>
    </div>
  );
}

function LinkedTile({ c }: { c: CatalogQualityCell | QueueCardView }) {
  return (
    <Link href={c.href} className="rounded-lg border border-slate-200 bg-white px-3 py-2 transition hover:border-slate-300 hover:bg-slate-50">
      <div className="flex items-center justify-between gap-2 text-[11px] text-muted">
        <span>{c.label}</span>
        <span aria-hidden className="opacity-50">↗</span>
      </div>
      <div className={`text-base font-bold ${c.status === "unknown" ? UNKNOWN_TONE : "text-slate-800"}`}>{c.value}</div>
    </Link>
  );
}

function SalesRow({ r }: { r: SalesRowView }) {
  return (
    <tr className="border-t border-slate-100">
      <td className="py-1.5 pe-3 font-medium text-slate-700">{r.label}</td>
      <td className={`py-1.5 pe-3 ${r.status === "unknown" ? UNKNOWN_TONE : "text-slate-800"}`}>{r.units}</td>
      <td className={`py-1.5 ${r.status === "unknown" ? UNKNOWN_TONE : "text-slate-800"}`}>{r.revenue}</td>
    </tr>
  );
}

function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="card space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-bold text-slate-800">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

const SEARCH_FIELDS: { value: SearchField; label: string }[] = [
  { value: "all", label: "الكل" },
  { value: "sku", label: "SKU" },
  { value: "product", label: "المنتج" },
  { value: "barcode", label: "الباركود" },
  { value: "brand", label: "العلامة" },
];

export default function ExecutiveDashboard({
  view,
  searchField,
  searchQuery,
  platformHealthSlot,
  channelSlot,
  healthSlot,
}: {
  view: ExecutiveDashboardView;
  searchField: SearchField;
  searchQuery: string;
  platformHealthSlot?: ReactNode;
  channelSlot?: ReactNode;
  healthSlot?: ReactNode;
}) {
  return (
    <div className="space-y-4">
      {/* §10 Search — delegates to the existing catalog search via a GET form */}
      <form action="/v2/catalog" method="get" className="card flex flex-wrap items-center gap-2" role="search">
        <input
          type="search"
          name="q"
          defaultValue={searchQuery}
          placeholder="ابحث بالـ SKU أو المنتج أو الباركود أو العلامة…"
          className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"
          aria-label="بحث لوحة الإدارة"
        />
        <select name="field" defaultValue={searchField} className="rounded-lg border border-slate-200 bg-white px-2 py-2 text-sm" aria-label="حقل البحث">
          {SEARCH_FIELDS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
        <button type="submit" className="rounded-lg bg-slate-800 px-4 py-2 text-sm font-semibold text-white">
          بحث
        </button>
      </form>

      {/* §2 KPI header */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7">
        {view.kpis.map((c) => (
          <KpiTile key={c.key} c={c} />
        ))}
        {platformHealthSlot}
      </div>

      {/* §3 Sales Overview */}
      <Section
        title="نظرة المبيعات"
        action={
          <span className={`text-xs ${view.sales.growth.status === "unknown" ? UNKNOWN_TONE : "text-slate-700"}`}>
            النمو: <span className="font-bold">{view.sales.growth.value}</span>
          </span>
        }
      >
        <table className="w-full text-start text-xs">
          <thead>
            <tr className="text-[11px] text-muted">
              <th className="pb-1 text-start font-semibold">الفترة</th>
              <th className="pb-1 text-start font-semibold">الوحدات</th>
              <th className="pb-1 text-start font-semibold">الإيراد</th>
            </tr>
          </thead>
          <tbody>
            {view.sales.rows.map((r) => (
              <SalesRow key={r.key} r={r} />
            ))}
            <SalesRow r={view.sales.lifetime} />
          </tbody>
        </table>
        <p className="text-[10px] text-slate-400">
          المبيعات حسب الفترة والنمو غير متوفّرة بعدُ (لا يوجد سجل مبيعات مؤرَّخ) — يُعرض الإجمالي التراكمي فقط.
        </p>
      </Section>

      {/* §4 Inventory Overview */}
      <Section title="نظرة المخزون">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {view.inventory.map((c) => (
            <StatTile key={c.key} c={c} />
          ))}
        </div>
      </Section>

      {/* §5 Channel Overview (streamed) */}
      {channelSlot}

      {/* §6 Catalog Quality */}
      <Section title="جودة الكتالوج">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {view.catalogQuality.map((c) => (
            <LinkedTile key={c.key} c={c} />
          ))}
        </div>
      </Section>

      {/* §7 Operations Summary */}
      <Section title="ملخّص العمليات">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {view.operations.map((c) => (
            <LinkedTile key={c.key} c={c} />
          ))}
        </div>
      </Section>

      {/* §8 + §9 Health Summary + Alerts (streamed) */}
      {healthSlot}

      <p className="text-[10px] text-slate-400">آخر تحديث للتحليلات: {view.generatedAt}</p>
    </div>
  );
}
