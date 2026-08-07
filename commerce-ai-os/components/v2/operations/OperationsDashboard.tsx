// Malikas V2 Operations Center dashboard (Phase UI.7.2). Server Component:
// no business logic here — it renders the values already computed by the
// lib/operations/* engines. Interactivity is a GET form + links (no client
// JS), so the server recomputes/paginates and the browser only receives the
// current page. Arabic RTL, mobile-first cards.

import Link from "next/link";
import {
  OPERATIONS_FILTER_LABELS,
  OPERATIONS_FILTER_VALUES,
  type OperationsControls,
  type OperationsFilter,
  type OperationsListItem,
  type OperationsPage,
} from "@/lib/operations/dashboard-view";
import { PLATFORM_LABELS } from "@/lib/operations/platforms/platform-status";
import type { HealthSummary, PlatformStatus, PlatformStatusValue } from "@/lib/operations/shared/models";

function opsHref(controls: OperationsControls, over: Partial<OperationsControls>): string {
  const c = { ...controls, ...over };
  const p = new URLSearchParams();
  if (c.query) p.set("query", c.query);
  if (c.filter !== "all") p.set("filter", c.filter);
  if (c.page > 1) p.set("page", String(c.page));
  const qs = p.toString();
  return qs ? `/v2/operations?${qs}` : "/v2/operations";
}

function KpiCard({
  label,
  value,
  filter,
  controls,
  tone,
}: {
  label: string;
  value: number;
  filter?: OperationsFilter;
  controls: OperationsControls;
  tone?: "brand" | "amber" | "rose" | "emerald";
}) {
  const toneClass =
    tone === "amber" ? "text-amber-700"
    : tone === "rose" ? "text-rose-700"
    : tone === "emerald" ? "text-emerald-700"
    : "text-ink";
  const inner = (
    <>
      <div className={"text-2xl font-bold " + toneClass}>{value}</div>
      <div className="mt-1 text-xs text-muted">{label}</div>
    </>
  );
  if (!filter) return <div className="card p-4 text-center">{inner}</div>;
  const active = controls.filter === filter;
  return (
    <Link
      href={opsHref(controls, { filter, page: 1 })}
      className={"card p-4 text-center transition-colors hover:shadow-md " + (active ? "ring-2 ring-brand" : "")}
      aria-current={active ? "true" : undefined}
    >
      {inner}
    </Link>
  );
}

const STATUS_TONE: Record<PlatformStatusValue, string> = {
  unknown: "bg-[#f5ece1] text-muted",
  missing: "bg-rose-50 text-rose-700",
  ready: "bg-emerald-50 text-emerald-700",
  published: "bg-emerald-50 text-emerald-700",
  different: "bg-amber-50 text-amber-800",
  review_required: "bg-amber-50 text-amber-800",
};

function PlatformBadge({ status }: { status: PlatformStatus }) {
  return (
    <span className="flex items-center justify-between gap-2 rounded-lg px-2 py-1 text-[11px]">
      <span className="text-muted">{PLATFORM_LABELS[status.platform]}</span>
      <span className={"rounded-full px-2 py-0.5 " + STATUS_TONE[status.status]}>{status.label}</span>
    </span>
  );
}

const PRIORITY_TONE: Record<string, string> = {
  high: "bg-rose-50 text-rose-700",
  medium: "bg-amber-50 text-amber-800",
  low: "bg-[#f5ece1] text-ink",
};

function ProductCard({ item }: { item: OperationsListItem }) {
  const name = item.nameAr || item.nameEn || item.sku || "منتج بدون اسم";
  return (
    <div className="card space-y-3 p-3">
      <div className="flex items-start gap-3">
        {item.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- catalog image URL
          <img src={item.imageUrl} alt={name} className="h-16 w-16 shrink-0 rounded-lg border border-[#efe3d6] object-cover" />
        ) : (
          <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg border border-dashed border-[#e6d5c2] text-[10px] text-muted">
            بلا صورة
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-ink">{name}</div>
          {item.nameEn && item.nameAr ? <div className="truncate text-xs text-muted" dir="ltr">{item.nameEn}</div> : null}
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted">
            <span dir="ltr">{item.sku ?? "—"}</span>
            <span dir="ltr">{item.barcode ?? "—"}</span>
            {typeof item.price === "number" ? <span>{item.price} ر.ق</span> : <span className="text-rose-600">بلا سعر</span>}
          </div>
        </div>
      </div>

      {/* readiness */}
      <div className="space-y-1">
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-muted">الجاهزية</span>
          <span className="font-semibold text-ink">{item.readinessPercent}%</span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-[#f1e6d8]">
          <div
            className={
              "h-2 rounded-full " +
              (item.readinessStatus === "ready" ? "bg-emerald-500"
                : item.readinessStatus === "needs_review" ? "bg-amber-500"
                : "bg-brand")
            }
            style={{ width: `${item.readinessPercent}%` }}
          />
        </div>
        <div className="flex flex-wrap gap-1 pt-0.5">
          {item.isNew ? <span className="rounded-full bg-brand-light px-2 py-0.5 text-[10px] text-brand">جديد</span> : null}
          {item.needsImage ? <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] text-amber-700">يحتاج صورة</span> : null}
          {item.needsReview ? <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] text-amber-700">يحتاج مراجعة</span> : null}
        </div>
        {item.reasons.length > 0 ? (
          <ul className="list-disc pr-4 text-[11px] text-muted">
            {item.reasons.slice(0, 4).map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        ) : null}
      </div>

      {/* platforms — Malikas is the source of truth */}
      <div className="space-y-1 border-t border-[#f5ece1] pt-2">
        <span className="flex items-center justify-between gap-2 rounded-lg px-2 py-1 text-[11px]">
          <span className="text-muted">Malikas</span>
          <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-emerald-700">✅ المصدر الرئيسي</span>
        </span>
        {item.platforms.map((p) => <PlatformBadge key={p.platform} status={p} />)}
      </div>

      {/* tasks */}
      {item.tasks.length > 0 ? (
        <div className="space-y-1 border-t border-[#f5ece1] pt-2">
          <div className="text-[11px] font-semibold text-ink">المهام ({item.taskCount})</div>
          {item.tasks.map((t) => (
            <div key={t.id} className="flex items-center justify-between gap-2 text-[11px]">
              <span className="min-w-0 flex-1 truncate text-ink">
                {t.title}
                {t.platform ? <span className="text-muted"> · {PLATFORM_LABELS[t.platform]}</span> : null}
              </span>
              <span className={"shrink-0 rounded-full px-2 py-0.5 " + (PRIORITY_TONE[t.priority] ?? "")}>
                {t.priority === "high" ? "عالية" : t.priority === "medium" ? "متوسطة" : "منخفضة"}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      <Link href={`/v2/catalog/${encodeURIComponent(item.id)}`} className="btn-ghost w-full text-center text-xs">
        فتح المنتج
      </Link>
    </div>
  );
}

export default function OperationsDashboard({
  health,
  page,
  matchCount,
  controls,
  partial,
  shopifyAvailable,
}: {
  health: HealthSummary;
  page: OperationsPage;
  matchCount: number;
  controls: OperationsControls;
  partial: boolean;
  shopifyAvailable: boolean;
}) {
  const hasPrev = page.page > 1;
  const hasNext = page.page < page.totalPages;

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h1 className="font-serif text-2xl font-semibold text-ink">مركز العمليات</h1>
        <p className="text-sm text-muted">جاهزية المنتجات والمهام وحالة المنصات — محسوبة من ماليكاس، المصدر الرئيسي.</p>
      </div>

      {partial ? (
        <div className="card border-amber-200 bg-amber-50 text-sm text-amber-800">
          النتائج جزئية — تم تحميل جزء من الكتالوج فقط ضمن الحد الآمن للقراءة.
        </div>
      ) : null}
      {!shopifyAvailable ? (
        <div className="card border-amber-200 bg-amber-50 text-sm text-amber-800">
          تعذر قراءة Shopify حاليًا — تظهر حالته «غير مربوط»، وبقية المركز يعمل من بيانات ماليكاس.
        </div>
      ) : null}

      {/* KPI cards — clickable filters */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        <KpiCard label="إجمالي المنتجات" value={health.totalProducts} filter="all" controls={controls} />
        <KpiCard label="منتجات جديدة" value={health.newProducts} filter="new" controls={controls} tone="brand" />
        <KpiCard label="يحتاج صورة" value={health.needsImage} filter="needs_image" controls={controls} tone="amber" />
        <KpiCard label="جاهز" value={health.readyProducts} filter="ready" controls={controls} tone="emerald" />
        <KpiCard label="إجمالي المهام" value={health.generatedTasks} filter="has_tasks" controls={controls} tone="rose" />
        <KpiCard label="متوسط الجاهزية" value={health.readinessAverage} controls={controls} />
        <KpiCard label="عرض حالي" value={matchCount} controls={controls} />
      </div>

      {/* search + filter (GET form; no client JS) */}
      <form method="get" className="card grid grid-cols-1 gap-3 p-4 sm:grid-cols-3">
        <label className="flex flex-col gap-1 sm:col-span-2">
          <span className="label">بحث (SKU أو باركود أو اسم)</span>
          <input type="search" name="query" defaultValue={controls.query} maxLength={80} className="input" placeholder="SKU أو باركود أو الاسم" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="label">الفلتر</span>
          <select name="filter" defaultValue={controls.filter} className="select-input">
            {OPERATIONS_FILTER_VALUES.map((f) => (
              <option key={f} value={f}>{OPERATIONS_FILTER_LABELS[f]}</option>
            ))}
          </select>
        </label>
        <div className="flex items-center gap-2 sm:col-span-3">
          <button type="submit" className="btn-primary">تطبيق</button>
          <Link href="/v2/operations" className="btn-ghost">مسح</Link>
        </div>
      </form>

      {/* results */}
      {matchCount === 0 ? (
        <div className="card text-center text-sm text-muted">
          {health.totalProducts === 0 ? "لا توجد منتجات في الكتالوج." : "لا توجد نتائج مطابقة للفلتر أو البحث الحالي."}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
            <span>عرض {page.startIndex + 1}–{page.startIndex + page.items.length} من {matchCount}</span>
            <span>صفحة {page.page} من {page.totalPages}</span>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {page.items.map((item) => <ProductCard key={item.id} item={item} />)}
          </div>

          {page.totalPages > 1 ? (
            <div className="flex items-center justify-between gap-2">
              {hasPrev ? (
                <Link href={opsHref(controls, { page: page.page - 1 })} className="btn-ghost" rel="prev">السابق</Link>
              ) : (
                <span className="btn-ghost cursor-default opacity-40" aria-disabled="true">السابق</span>
              )}
              <span className="text-xs text-muted">صفحة {page.page} من {page.totalPages}</span>
              {hasNext ? (
                <Link href={opsHref(controls, { page: page.page + 1 })} className="btn-ghost" rel="next">التالي</Link>
              ) : (
                <span className="btn-ghost cursor-default opacity-40" aria-disabled="true">التالي</span>
              )}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
