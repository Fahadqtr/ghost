// Malikas V2 Smart Tasks (Phase UI.7.3). Server Component: no business logic
// here — it renders the tasks already COMPUTED by the lib/operations/* engines
// and flattened by the reader. Tasks are never stored and never manually
// completed; there is no done/assign/delete/edit action — the only action is a
// link to open the product. Interactivity is a GET form + links (no client JS),
// so the server sorts/filters/searches/paginates and the browser receives only
// the current page. Arabic RTL, mobile-first cards.

import Link from "next/link";
import {
  TASK_FILTER_LABELS,
  TASK_FILTER_VALUES,
  TASK_ICONS,
  type TaskControls,
  type TaskFilter,
  type TaskPage,
  type TaskSummary,
  type TaskViewItem,
} from "@/lib/operations/tasks-view";
import { PLATFORM_LABELS } from "@/lib/operations/platforms/platform-status";
import type { TaskPriority, TaskType } from "@/lib/operations/shared/models";
import { syncTickTickAction, previewOneTickTickTask, syncOneTickTickTask } from "@/app/(v2)/v2/tasks/actions";

/** The dry-run plan surfaced back on the previewed card (deterministic). */
type TickTickCardPreview = {
  action: "create" | "update" | "skip";
  projectKey: string;
  title: string;
  descriptionSummary: string;
  marker: string;
};

type TickTickCardInfo = { configured: boolean; preview: TickTickCardPreview | null };

const PLAN_VERB: Record<"create" | "update" | "skip", string> = {
  create: "سيتم إنشاء هذه المهمة في TickTick",
  update: "سيتم تحديث هذه المهمة في TickTick",
  skip: "لن تُنفَّذ — القائمة غير مهيأة",
};

function tasksHref(controls: TaskControls, over: Partial<TaskControls>): string {
  const c = { ...controls, ...over };
  const p = new URLSearchParams();
  if (c.query) p.set("query", c.query);
  if (c.filter !== "all") p.set("filter", c.filter);
  if (c.page > 1) p.set("page", String(c.page));
  const qs = p.toString();
  return qs ? `/v2/tasks?${qs}` : "/v2/tasks";
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
  filter: TaskFilter;
  controls: TaskControls;
  tone?: "rose" | "amber" | "emerald" | "brand";
}) {
  const toneClass =
    tone === "rose" ? "text-rose-700"
    : tone === "amber" ? "text-amber-700"
    : tone === "emerald" ? "text-emerald-700"
    : tone === "brand" ? "text-brand"
    : "text-ink";
  const active = controls.filter === filter;
  return (
    <Link
      href={tasksHref(controls, { filter, page: 1 })}
      className={"card p-4 text-center transition-colors hover:shadow-md " + (active ? "ring-2 ring-brand" : "")}
      aria-current={active ? "true" : undefined}
    >
      <div className={"text-2xl font-bold " + toneClass}>{value}</div>
      <div className="mt-1 text-xs text-muted">{label}</div>
    </Link>
  );
}

const PRIORITY_TONE: Record<TaskPriority, string> = {
  high: "bg-rose-50 text-rose-700",
  medium: "bg-amber-50 text-amber-800",
  low: "bg-[#f5ece1] text-ink",
};

const PRIORITY_LABEL: Record<TaskPriority, string> = {
  high: "عالية",
  medium: "متوسطة",
  low: "منخفضة",
};

// A small, purely-decorative glyph per task type. The mapping key is
// single-sourced in TASK_ICONS (pure + testable); this only turns it into an
// emoji marker so the card reads at a glance. aria-hidden — the title carries
// the meaning for screen readers.
const ICON_GLYPH: Record<string, string> = {
  image: "🖼️",
  data: "📝",
  review: "🔍",
  new: "✨",
  publish: "🚀",
};

function TaskIcon({ type }: { type: TaskType }) {
  const glyph = ICON_GLYPH[TASK_ICONS[type]] ?? "•";
  return (
    <span
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#faf3ec] text-lg"
      aria-hidden="true"
    >
      {glyph}
    </span>
  );
}

function TaskCard({ item, ticktick }: { item: TaskViewItem; ticktick?: TickTickCardInfo }) {
  const { task } = item;
  const name = item.nameAr || item.nameEn || item.sku || "منتج بدون اسم";
  const preview = ticktick?.preview ?? null;
  return (
    <div className="card space-y-3 p-3">
      <div className="flex items-start gap-3">
        <TaskIcon type={task.type} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <span className="min-w-0 text-sm font-semibold text-ink">{task.title}</span>
            <span className={"shrink-0 rounded-full px-2 py-0.5 text-[11px] " + PRIORITY_TONE[task.priority]}>
              {PRIORITY_LABEL[task.priority]}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-muted">{task.description}</p>
          {task.reason ? <p className="mt-0.5 text-[11px] text-muted">السبب: {task.reason}</p> : null}
          {task.platform ? (
            <span className="mt-1 inline-block rounded-full bg-[#f5ece1] px-2 py-0.5 text-[10px] text-ink">
              {PLATFORM_LABELS[task.platform]}
            </span>
          ) : null}
        </div>
      </div>

      {/* the product this task belongs to */}
      <div className="flex items-center gap-3 border-t border-[#f5ece1] pt-2">
        {item.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- catalog image URL
          <img src={item.imageUrl} alt={name} className="h-12 w-12 shrink-0 rounded-lg border border-[#efe3d6] object-cover" />
        ) : (
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border border-dashed border-[#e6d5c2] text-[10px] text-muted">
            بلا صورة
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-ink">{name}</div>
          {item.nameEn && item.nameAr ? <div className="truncate text-[11px] text-muted" dir="ltr">{item.nameEn}</div> : null}
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-muted">
            <span dir="ltr">{item.sku ?? "—"}</span>
            <span dir="ltr">{item.barcode ?? "—"}</span>
            <span>الجاهزية {item.readinessPercent}%</span>
          </div>
        </div>
      </div>

      <Link href={`/v2/catalog/${encodeURIComponent(item.productId)}`} className="btn-ghost w-full text-center text-xs">
        فتح المنتج
      </Link>

      {/* Owner-only safe single-task TickTick controls (server actions; no client
          JS). Shown only when TickTick is connected AND this task's list is
          configured — otherwise a fixed notice replaces the buttons. The buttons
          pass ONLY the task id; the server re-derives everything else. */}
      {ticktick ? (
        ticktick.configured ? (
          <div className="space-y-2 border-t border-[#f5ece1] pt-2">
            <form action={previewOneTickTickTask.bind(null, task.id)}>
              <button type="submit" className="btn-ghost w-full text-center text-xs">معاينة TickTick</button>
            </form>
            {preview ? (
              <div className="space-y-2 rounded-lg bg-[#faf3ec] p-2 text-[11px] text-ink" role="status">
                {preview.action === "skip" ? (
                  <p>قائمة TickTick لهذه المهمة غير مهيأة.</p>
                ) : (
                  <>
                    <p className="font-medium">{PLAN_VERB[preview.action]}</p>
                    <p className="text-muted">القائمة: {preview.projectKey}</p>
                    <p className="truncate">العنوان: {preview.title}</p>
                    <p className="whitespace-pre-line text-muted">{preview.descriptionSummary}</p>
                    <p className="text-muted" dir="ltr">{preview.marker}</p>
                    <form action={syncOneTickTickTask.bind(null, task.id)}>
                      <button type="submit" className="btn-primary w-full text-center text-xs">مزامنة هذه المهمة</button>
                    </form>
                  </>
                )}
              </div>
            ) : null}
          </div>
        ) : (
          <p className="border-t border-[#f5ece1] pt-2 text-[11px] text-muted">
            قائمة TickTick لهذه المهمة غير مهيأة.
          </p>
        )
      ) : null}
    </div>
  );
}

export default function SmartTasks({
  summary,
  page,
  matchCount,
  controls,
  partial,
  shopifyAvailable,
  ticktickConnected = false,
  canSync = false,
  ticktickCards,
  preview = null,
  ticktickNotice = null,
}: {
  summary: TaskSummary;
  page: TaskPage;
  matchCount: number;
  controls: TaskControls;
  partial: boolean;
  shopifyAvailable: boolean;
  ticktickConnected?: boolean;
  canSync?: boolean;
  ticktickCards?: Record<string, { configured: boolean }>;
  preview?: {
    operationTaskId: string;
    action: "create" | "update" | "skip";
    projectKey: string;
    title: string;
    descriptionSummary: string;
    marker: string;
  } | null;
  ticktickNotice?: { tone: "ok" | "error" | "info"; text: string } | null;
}) {
  const hasPrev = page.page > 1;
  const hasNext = page.page < page.totalPages;

  const noticeToneClass =
    ticktickNotice?.tone === "ok" ? "border-emerald-200 bg-emerald-50 text-emerald-700"
    : ticktickNotice?.tone === "error" ? "border-rose-200 bg-rose-50 text-rose-700"
    : "border-amber-200 bg-amber-50 text-amber-800";

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="font-serif text-2xl font-semibold text-ink">المهام الذكية</h1>
          <p className="text-sm text-muted">
            مهام محسوبة تلقائيًا من جاهزية المنتجات وحالة المنصات — لا تُحفظ ولا تُغلق يدويًا؛ تختفي بمجرد معالجة سببها.
          </p>
        </div>
        {/* TickTick integration status + owner-only manual sync (no client JS). */}
        <div className="flex shrink-0 items-center gap-2">
          <span
            className={
              "rounded-full px-2 py-1 text-[11px] " +
              (ticktickConnected ? "bg-emerald-50 text-emerald-700" : "bg-[#f5ece1] text-muted")
            }
          >
            TickTick: {ticktickConnected ? "مربوط" : "غير مربوط"}
          </span>
          {canSync ? (
            <form action={syncTickTickAction}>
              <button type="submit" className="btn-ghost text-xs">مزامنة TickTick</button>
            </form>
          ) : null}
        </div>
      </div>

      {ticktickNotice ? (
        <div className={"card text-sm " + noticeToneClass} role="status">{ticktickNotice.text}</div>
      ) : null}

      {partial ? (
        <div className="card border-amber-200 bg-amber-50 text-sm text-amber-800">
          النتائج جزئية — تم تحميل جزء من الكتالوج فقط ضمن الحد الآمن للقراءة.
        </div>
      ) : null}
      {!shopifyAvailable ? (
        <div className="card border-amber-200 bg-amber-50 text-sm text-amber-800">
          تعذر قراءة Shopify حاليًا — حالته «غير مربوط»، ولن تظهر مهام نشر لـ Shopify حتى تتوفر قراءة موثوقة.
        </div>
      ) : null}

      {/* KPI cards — clickable filters */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <KpiCard label="إجمالي المهام" value={summary.total} filter="all" controls={controls} />
        <KpiCard label="عالية" value={summary.high} filter="high" controls={controls} tone="rose" />
        <KpiCard label="متوسطة" value={summary.medium} filter="medium" controls={controls} tone="amber" />
        <KpiCard label="منخفضة" value={summary.low} filter="low" controls={controls} />
        <KpiCard label="يحتاج صورة" value={summary.needsImage} filter="needs_image" controls={controls} tone="amber" />
        <KpiCard label="يحتاج مراجعة" value={summary.needsReview} filter="needs_review" controls={controls} tone="amber" />
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
            {TASK_FILTER_VALUES.map((f) => (
              <option key={f} value={f}>{TASK_FILTER_LABELS[f]}</option>
            ))}
          </select>
        </label>
        <div className="flex items-center gap-2 sm:col-span-3">
          <button type="submit" className="btn-primary">تطبيق</button>
          <Link href="/v2/tasks" className="btn-ghost">مسح</Link>
        </div>
      </form>

      {/* results */}
      {matchCount === 0 ? (
        <div className="card text-center text-sm text-muted">
          {summary.total === 0 ? "لا توجد مهام حالياً" : "لا توجد مهام مطابقة للفلتر أو البحث الحالي."}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
            <span>عرض {page.startIndex + 1}–{page.startIndex + page.items.length} من {matchCount}</span>
            <span>صفحة {page.page} من {page.totalPages}</span>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {page.items.map((item) => {
              const info = canSync ? ticktickCards?.[item.task.id] : undefined;
              const ticktick: TickTickCardInfo | undefined = info
                ? {
                    configured: info.configured,
                    preview: preview && preview.operationTaskId === item.task.id ? preview : null,
                  }
                : undefined;
              return <TaskCard key={item.task.id} item={item} ticktick={ticktick} />;
            })}
          </div>

          {page.totalPages > 1 ? (
            <div className="flex items-center justify-between gap-2">
              {hasPrev ? (
                <Link href={tasksHref(controls, { page: page.page - 1 })} className="btn-ghost" rel="prev">السابق</Link>
              ) : (
                <span className="btn-ghost cursor-default opacity-40" aria-disabled="true">السابق</span>
              )}
              <span className="text-xs text-muted">صفحة {page.page} من {page.totalPages}</span>
              {hasNext ? (
                <Link href={tasksHref(controls, { page: page.page + 1 })} className="btn-ghost" rel="next">التالي</Link>
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
