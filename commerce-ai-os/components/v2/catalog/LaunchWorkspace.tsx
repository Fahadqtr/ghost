"use client";

// WAVE.1A — Launch Campaign Workspace (PRESENTATIONAL + view filters). Renders the
// pre-composed LaunchWorkspaceModel: campaign progress, Wave 1 queue, the work
// queue, filters, and the completion summary. It holds NO data client, issues NO
// queries and performs NO writes — every row deep-links to the EXISTING product
// editor (/v2/catalog/[id]); no new editing UI is introduced. Filters are pure
// view state.

import { useMemo, useState } from "react";
import Link from "next/link";
import type { LaunchWorkspaceModel, WorkQueueRow, BlockerKey } from "@/lib/catalog/launch/launch-workspace";

const UNKNOWN_TEXT = "—";
const PAGE = 60;

function fmt(v: number | "UNKNOWN"): string {
  return typeof v === "number" && Number.isFinite(v) ? v.toLocaleString("ar-QA") : UNKNOWN_TEXT;
}

type FilterKey =
  | "all" | "images" | "prices" | "variants"
  | "shopify" | "talabat" | "snoonu" | "rafeeq"
  | "completed" | "blocked";

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "الكل" },
  { key: "images", label: "الصور" },
  { key: "prices", label: "الأسعار" },
  { key: "variants", label: "الخيارات" },
  { key: "shopify", label: "Shopify" },
  { key: "talabat", label: "Talabat" },
  { key: "snoonu", label: "Snoonu" },
  { key: "rafeeq", label: "Rafeeq" },
  { key: "blocked", label: "محظور" },
  { key: "completed", label: "مكتمل" },
];

const PRIORITY_TONE: Record<WorkQueueRow["priority"], string> = {
  high: "bg-rose-50 text-rose-700 border-rose-200",
  medium: "bg-amber-50 text-amber-700 border-amber-200",
  low: "bg-slate-50 text-slate-600 border-slate-200",
};
const PRIORITY_LABEL: Record<WorkQueueRow["priority"], string> = { high: "عالٍ", medium: "متوسط", low: "منخفض" };

const BLOCKER_MATCHES_FILTER: Partial<Record<FilterKey, BlockerKey>> = {
  images: "image", prices: "price", variants: "variants",
};

function StatTile({ label, value, tone = "neutral" }: { label: string; value: string; tone?: "neutral" | "good" | "warn" | "bad" }) {
  const cls = { neutral: "border-slate-200 bg-white text-slate-700", good: "border-emerald-200 bg-emerald-50 text-emerald-700", warn: "border-amber-200 bg-amber-50 text-amber-700", bad: "border-rose-200 bg-rose-50 text-rose-700" }[tone];
  return (
    <div className={`rounded-xl border px-3 py-2 ${cls}`}>
      <div className="text-lg font-bold">{value}</div>
      <div className="text-[11px] font-semibold opacity-90">{label}</div>
    </div>
  );
}

export default function LaunchWorkspace({ model }: { model: LaunchWorkspaceModel }) {
  const [filter, setFilter] = useState<FilterKey>("all");
  const [limit, setLimit] = useState(PAGE);

  const filtered = useMemo(() => {
    const rows = model.rows;
    if (filter === "all" || filter === "blocked") return rows; // the queue is the blocked set
    if (filter === "completed") return []; // completed products are done — not in the work queue
    const bk = BLOCKER_MATCHES_FILTER[filter];
    if (bk) return rows.filter((r) => r.blockerKey === bk);
    // channel filters
    return rows.filter((r) => r.channels[filter as "shopify" | "talabat" | "snoonu" | "rafeeq"]);
  }, [model.rows, filter]);

  const shown = filtered.slice(0, limit);
  const cp = model.campaignProgress;

  return (
    <div className="space-y-6">
      {/* SECTION 1 — Campaign Progress */}
      <section className="card">
        <h2 className="mb-2 text-sm font-bold text-brand">تقدّم الحملة</h2>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <StatTile label="جاهزية الإطلاق ٪" value={typeof cp.readinessPct === "number" ? `${cp.readinessPct}%` : UNKNOWN_TEXT} tone={typeof cp.readinessPct === "number" && cp.readinessPct >= 90 ? "good" : "warn"} />
          <StatTile label="منتجات متبقية" value={fmt(cp.productsRemaining)} tone="warn" />
          <StatTile label="أُنجز اليوم" value={fmt(cp.completedToday)} />
          <StatTile label="في قائمة العمل" value={fmt(model.completionSummary.inQueue)} />
        </div>
        <div className="mt-3 space-y-1.5">
          {cp.waveProgress.map((w) => (
            <div key={w.wave} className="flex items-center gap-2 text-xs">
              <span className="w-40 shrink-0 text-slate-500">{w.label}</span>
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
                <div className={`h-full rounded-full ${w.wave === 1 ? "bg-rose-400" : w.wave === 2 ? "bg-amber-400" : "bg-brand/50"}`} style={{ width: `${Math.min(100, (w.total / Math.max(1, model.completionSummary.inQueue)) * 100)}%` }} />
              </div>
              <span className="w-10 shrink-0 text-end font-semibold text-slate-700">{w.total.toLocaleString("ar-QA")}</span>
            </div>
          ))}
        </div>
      </section>

      {/* SECTION 2 — Wave 1 Queue */}
      <section className="card border-rose-200">
        <h2 className="mb-2 text-sm font-bold text-rose-700">الموجة ١ — المعوّقات الحرجة ({model.wave1Queue.total.toLocaleString("ar-QA")})</h2>
        <div className="grid grid-cols-3 gap-2">
          <button type="button" onClick={() => { setFilter("images"); setLimit(PAGE); }} className="text-start"><StatTile label="صور ناقصة" value={model.wave1Queue.missingImages.toLocaleString("ar-QA")} tone="bad" /></button>
          <button type="button" onClick={() => { setFilter("prices"); setLimit(PAGE); }} className="text-start"><StatTile label="أسعار ناقصة" value={model.wave1Queue.missingPrices.toLocaleString("ar-QA")} tone="bad" /></button>
          <button type="button" onClick={() => { setFilter("variants"); setLimit(PAGE); }} className="text-start"><StatTile label="مشاكل الخيارات" value={model.wave1Queue.variantProblems.toLocaleString("ar-QA")} tone="warn" /></button>
        </div>
      </section>

      {/* SECTION 5 — Filters */}
      <section>
        <div className="flex flex-wrap gap-2">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => { setFilter(f.key); setLimit(PAGE); }}
              className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition ${filter === f.key ? "border-brand bg-brand text-white" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </section>

      {/* SECTION 3/4 — Work Queue (each row → existing editor) */}
      <section className="card">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-bold text-slate-700">قائمة العمل ({filtered.length.toLocaleString("ar-QA")})</h2>
        </div>
        {filtered.length === 0 ? (
          <p className="text-xs text-muted">
            {filter === "completed" ? "المنتجات المكتملة ليست في قائمة العمل — راجع ملخّص الإنجاز." : "لا توجد عناصر مطابقة."}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-start text-xs">
              <thead className="text-[11px] text-slate-400">
                <tr>
                  <th className="p-2 text-start">صورة</th>
                  <th className="p-2 text-start">SKU</th>
                  <th className="p-2 text-start">المنتج</th>
                  <th className="p-2 text-start">المعوّق</th>
                  <th className="p-2 text-start">الأولوية</th>
                  <th className="p-2 text-start">الموجة</th>
                  <th className="p-2 text-start"></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.id} className="border-t border-[#efe3d6]">
                    <td className="p-2">
                      {r.imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={r.imageUrl} alt="" className="h-9 w-9 rounded object-cover" />
                      ) : (
                        <div className="flex h-9 w-9 items-center justify-center rounded bg-slate-100 text-[9px] text-slate-400">لا صورة</div>
                      )}
                    </td>
                    <td className="p-2 font-mono text-slate-500" dir="ltr">{r.sku}</td>
                    <td className="max-w-[220px] truncate p-2 text-slate-700">{r.name}</td>
                    <td className="p-2 text-slate-600">{r.blocker}</td>
                    <td className="p-2"><span className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${PRIORITY_TONE[r.priority]}`}>{PRIORITY_LABEL[r.priority]}</span></td>
                    <td className="p-2 font-semibold text-slate-500">{r.wave}</td>
                    <td className="p-2">
                      <div className="flex items-center gap-1.5">
                        <Link href={r.href} className="rounded-lg bg-brand px-2.5 py-1 text-[11px] font-semibold text-white hover:opacity-90">فتح المحرّر ↗</Link>
                        {r.blockerKey === "image" ? (
                          <Link href={`/v2/operations/media/discovery?productId=${encodeURIComponent(r.id)}`} className="rounded-lg border border-sky-200 bg-sky-50 px-2 py-1 text-[11px] font-semibold text-sky-700 hover:bg-sky-100">🔍 استرجاع من Snoonu</Link>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filtered.length > shown.length ? (
              <button type="button" onClick={() => setLimit((n) => n + PAGE)} className="mt-3 w-full rounded-lg border border-slate-200 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50">
                عرض المزيد ({(filtered.length - shown.length).toLocaleString("ar-QA")} متبقٍّ)
              </button>
            ) : null}
          </div>
        )}
      </section>

      {/* SECTION 6 — Completion Summary */}
      <section className="card">
        <h2 className="mb-2 text-sm font-bold text-slate-700">ملخّص الإنجاز</h2>
        <div className="grid grid-cols-3 gap-2">
          <StatTile label="مكتمل (جاهز للنشر)" value={fmt(model.completionSummary.completed)} tone="good" />
          <StatTile label="متبقٍّ (محظور)" value={fmt(model.completionSummary.remaining)} tone="warn" />
          <StatTile label="في قائمة العمل الآن" value={model.completionSummary.inQueue.toLocaleString("ar-QA")} />
        </div>
        <p className="mt-2 text-[11px] text-slate-400">«أُنجز اليوم» غير متوفّر — لا يوجد مصدر معتمد لعدّ الإنجاز اليومي، فلا تُختلق قيمة.</p>
      </section>
    </div>
  );
}
