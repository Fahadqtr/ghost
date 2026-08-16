// Malikas V2 Operations Center dashboard (Phase UI.8). Server Component: NO
// business logic here — it renders values already computed by the
// lib/operations/* engines and the pure summary layer (KPIs, queues, platform
// overview). Interactivity is a GET form + links (no client JS), so the server
// recomputes/paginates and the browser only receives the KPIs, per-queue top
// items and the current page. Arabic RTL, mobile-first cards.

import Link from "next/link";
import {
  OPERATIONS_FILTER_LABELS,
  OPERATIONS_FILTER_VALUES,
  type OperationsControls,
  type OperationsFilter,
  type OperationsListItem,
  type OperationsPage,
} from "@/lib/operations/dashboard-view";
import {
  QUEUE_FILTER,
  type DashboardKpis,
  type PlatformOverview,
  type PureSoulOverview,
  type TalabatOverview,
  type RafeeqOverview,
  type Queue,
  type QueueItem,
  type QueueKey,
} from "@/lib/operations/dashboard-summary";
import { PLATFORM_LABELS } from "@/lib/operations/platforms/platform-status";
import type { PlatformStatus, PlatformStatusValue } from "@/lib/operations/shared/models";
import {
  QUEUE_VALUES,
  QUEUE_LABELS,
  ISSUE_REASON_LABELS,
  ISSUE_SEVERITY_LABELS,
  type QueueControl,
  type QueueCounts,
  type QueueKey as IssueQueueKey,
  type IssuePage,
  type IssueSeverity,
} from "@/lib/operations/operations-queue";
import { MATRIX_STATE_LABELS } from "@/lib/operations/platform-matrix";
import { resolveIssueHref, productDetailHref } from "@/lib/operations/issue-resolver";
import type { PlatformHealth } from "@/lib/operations/platform-health";
import PlatformHealthSection from "@/components/v2/operations/PlatformHealth";
import InPageNav from "@/components/v2/InPageNav";

function opsHref(controls: OperationsControls, over: Partial<OperationsControls>): string {
  const c = { ...controls, ...over };
  const p = new URLSearchParams();
  if (c.query) p.set("query", c.query);
  if (c.filter !== "all") p.set("filter", c.filter);
  if (c.page > 1) p.set("page", String(c.page));
  const qs = p.toString();
  return qs ? `/v2/operations?${qs}` : "/v2/operations";
}

/** Queue link: preserves the product-list controls, sets queue + qpage. */
function queueHref(controls: OperationsControls, queue: IssueQueueKey, qpage: number): string {
  const p = new URLSearchParams();
  if (controls.query) p.set("query", controls.query);
  if (controls.filter !== "all") p.set("filter", controls.filter);
  if (controls.page > 1) p.set("page", String(controls.page));
  if (queue !== "all") p.set("queue", queue);
  if (qpage > 1) p.set("qpage", String(qpage));
  const qs = p.toString();
  return (qs ? `/v2/operations?${qs}` : "/v2/operations") + "#unified-queue";
}

// ── KPI cards ─────────────────────────────────────────────────────────────────

function KpiCard({
  label,
  value,
  suffix,
  filter,
  controls,
  tone,
}: {
  label: string;
  value: number;
  suffix?: string;
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
      <div className={"text-2xl font-bold " + toneClass}>{value}{suffix ?? ""}</div>
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

// ── platform badges / overview ─────────────────────────────────────────────────

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

function OverviewStat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="flex items-center justify-between rounded-lg bg-[#faf3ec] px-3 py-2 text-xs">
      <span className="text-muted">{label}</span>
      <span className={"font-bold " + (tone ?? "text-ink")}>{value}</span>
    </div>
  );
}

function PureSoulOverviewCard({ ps }: { ps: PureSoulOverview }) {
  return (
    <div className="card space-y-2 p-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-ink">PureSoul</span>
        <span
          className={
            "rounded-full px-2 py-0.5 text-[10px] " +
            (ps.available ? "bg-emerald-50 text-emerald-700" : "bg-[#f5ece1] text-muted")
          }
        >
          {ps.available ? "مربوط" : "غير مربوط"}
        </span>
      </div>
      {ps.available ? (
        <div className="space-y-1">
          <OverviewStat label="منشور" value={ps.published} tone="text-emerald-700" />
          <OverviewStat label="غير موجود" value={ps.missing} tone="text-rose-700" />
          <OverviewStat label="فرق سعر" value={ps.priceDifferent} tone="text-amber-700" />
          <OverviewStat label="مختلف" value={ps.different} tone="text-amber-700" />
          <OverviewStat label="نافد (مخلّصة)" value={ps.outOfStock} tone="text-amber-700" />
          <OverviewStat label="مراجعة" value={ps.reviewRequired} tone="text-amber-700" />
          <OverviewStat label="غير معروف" value={ps.unknown} tone="text-muted" />
          <p className="pt-1 text-[10px] text-muted">
            آخر لقطة: {ps.lastCapturedAt ? new Date(ps.lastCapturedAt).toLocaleString("ar") : "—"}
            {ps.stale ? " · ⚠️ قديمة (أكثر من ٢٤ ساعة)" : ""}
          </p>
        </div>
      ) : (
        <p className="text-[11px] text-muted">لا توجد لقطة بعد — لا تُحتسب كغير موجودة.</p>
      )}
    </div>
  );
}

function TalabatOverviewCard({ tb }: { tb: TalabatOverview }) {
  return (
    <div className="card space-y-2 p-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-ink">Talabat</span>
        <span
          className={
            "rounded-full px-2 py-0.5 text-[10px] " +
            (tb.available ? "bg-emerald-50 text-emerald-700" : "bg-[#f5ece1] text-muted")
          }
        >
          {tb.available ? "مربوط" : "غير مربوط"}
        </span>
      </div>
      {tb.available ? (
        <div className="space-y-1">
          <OverviewStat label="موجود" value={tb.present} tone="text-emerald-700" />
          <OverviewStat label="غير موجود" value={tb.missing} tone="text-rose-700" />
          <OverviewStat label="مراجعة" value={tb.review} tone="text-amber-700" />
          <OverviewStat label="مربوط/جاهز" value={tb.linked} tone="text-sky-700" />
          <OverviewStat label="غير معروف" value={tb.unknown} tone="text-muted" />
          <p className="pt-1 text-[10px] text-muted">
            آخر لقطة: {tb.lastCapturedAt ? new Date(tb.lastCapturedAt).toLocaleString("ar") : "—"}
            {tb.lastCapturedAt && tb.stale ? " · ⚠️ قديمة (أكثر من ٧ أيام)" : ""}
          </p>
        </div>
      ) : (
        <p className="text-[11px] text-muted">لا توجد لقطة/رابط بعد — لا تُحتسب كغير موجودة.</p>
      )}
    </div>
  );
}

function RafeeqOverviewCard({ rf }: { rf: RafeeqOverview }) {
  return (
    <div className="card space-y-2 p-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-ink">Rafeeq</span>
        <span
          className={
            "rounded-full px-2 py-0.5 text-[10px] " +
            (rf.available ? "bg-emerald-50 text-emerald-700" : "bg-[#f5ece1] text-muted")
          }
        >
          {rf.available ? "مربوط" : "غير مربوط"}
        </span>
      </div>
      {rf.available ? (
        <div className="space-y-1">
          <OverviewStat label="موجود" value={rf.present} tone="text-emerald-700" />
          <OverviewStat label="غير موجود" value={rf.missing} tone="text-rose-700" />
          <OverviewStat label="مربوط/جاهز" value={rf.linked} tone="text-sky-700" />
          <OverviewStat label="غير معروف" value={rf.unknown} tone="text-muted" />
          <p className="pt-1 text-[10px] text-muted">
            آخر لقطة: {rf.lastCapturedAt ? new Date(rf.lastCapturedAt).toLocaleString("ar") : "—"}
            {rf.lastCapturedAt && rf.stale ? " · ⚠️ قديمة (أكثر من ٧ أيام)" : ""}
          </p>
        </div>
      ) : (
        <p className="text-[11px] text-muted">لا توجد لقطة/رابط بعد — لا تُحتسب كغير موجودة.</p>
      )}
    </div>
  );
}

function PlatformOverviewSection({ overview }: { overview: PlatformOverview }) {
  const s = overview.shopify;
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-ink">نظرة عامة على المنصات</h2>
        {/* OPS.7 §6 — the freshness/staleness notes below are diagnosed here; the
            snapshot refresh runs automatically on load. This links to the safe
            diagnostic route (Platform Health) and re-renders the dashboard. */}
        <Link href="/v2/operations/health" className="text-xs font-semibold text-sky-700 hover:underline">
          صحّة المنصّة والتحديث ↗
        </Link>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {/* Malikas — source of truth */}
        <div className="card space-y-2 p-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-ink">Malikas</span>
            <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] text-emerald-700">✅ المصدر الرئيسي</span>
          </div>
          <p className="text-[11px] text-muted">كل الحسابات تُشتق من ماليكاس.</p>
        </div>

        {/* Shopify — the only connected platform today */}
        <div className="card space-y-2 p-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-ink">Shopify</span>
            <span
              className={
                "rounded-full px-2 py-0.5 text-[10px] " +
                (s.available ? "bg-emerald-50 text-emerald-700" : "bg-[#f5ece1] text-muted")
              }
            >
              {s.available ? "مربوط" : "غير مربوط"}
            </span>
          </div>
          {s.available ? (
            <div className="space-y-1">
              <OverviewStat label="منشور" value={s.published} tone="text-emerald-700" />
              <OverviewStat label="غير موجود" value={s.missing} tone="text-rose-700" />
              <OverviewStat label="مختلف" value={s.different} tone="text-amber-700" />
              <OverviewStat label="يحتاج مراجعة" value={s.reviewRequired} tone="text-amber-700" />
              <OverviewStat label="جاهز للنشر" value={s.ready} tone="text-sky-700" />
              <p className="pt-1 text-[10px] text-muted">
                آخر لقطة: {s.lastCapturedAt ? new Date(s.lastCapturedAt).toLocaleString("ar") : "—"}
                {s.lastCapturedAt && s.stale ? " · ⚠️ قديمة (أكثر من ٢٤ ساعة)" : ""}
              </p>
            </div>
          ) : (
            <p className="text-[11px] text-muted">تعذر قراءة Shopify حاليًا — لا تُحتسب المنتجات كغير موجودة.</p>
          )}
        </div>

        {/* PureSoul — real overlay reader (UI.9.1); «غير مربوط» when not synced */}
        <PureSoulOverviewCard ps={overview.puresoul} />

        {/* Talabat — upload-derived snapshot + mapping-linked baseline (UI.9.6) */}
        <TalabatOverviewCard tb={overview.talabat} />

        {/* Rafeeq — channel_products / rafeeq_product_id overlays (UI.9.7) */}
        <RafeeqOverviewCard rf={overview.rafeeq} />
      </div>
    </section>
  );
}

// ── queues ──────────────────────────────────────────────────────────────────

const QUEUE_TITLES: Record<QueueKey, string> = {
  new: "منتجات جديدة",
  needs_image: "يحتاج صورة",
  needs_review: "يحتاج مراجعة",
  ready: "جاهز للإطلاق",
  platform_issues: "مشاكل المنصات",
  high_priority: "مهام أولوية عالية",
};

function QueueRow({ item }: { item: QueueItem }) {
  const name = item.nameAr || item.nameEn || item.sku || "منتج بدون اسم";
  return (
    <Link
      href={`/v2/catalog/${encodeURIComponent(item.id)}`}
      className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-[#faf3ec]"
    >
      {item.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- catalog image URL
        <img src={item.imageUrl} alt={name} className="h-8 w-8 shrink-0 rounded border border-[#efe3d6] object-cover" />
      ) : (
        <div className="h-8 w-8 shrink-0 rounded border border-dashed border-[#e6d5c2]" aria-hidden="true" />
      )}
      <span className="min-w-0 flex-1 truncate text-[11px] text-ink">{name}</span>
      <span className="shrink-0 text-[10px] text-muted">{item.readinessPercent}%</span>
    </Link>
  );
}

function QueueCard({ queue, controls }: { queue: Queue; controls: OperationsControls }) {
  return (
    <div className="card space-y-2 p-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-ink">{QUEUE_TITLES[queue.key]}</span>
        <span className="rounded-full bg-[#f5ece1] px-2 py-0.5 text-[10px] text-ink">{queue.total}</span>
      </div>
      {queue.items.length === 0 ? (
        <p className="py-2 text-center text-[11px] text-muted">لا عناصر</p>
      ) : (
        <div className="space-y-0.5">
          {queue.items.map((it) => <QueueRow key={it.id} item={it} />)}
        </div>
      )}
      {queue.total > queue.items.length ? (
        <Link
          href={opsHref(controls, { filter: QUEUE_FILTER[queue.key] as OperationsFilter, page: 1 })}
          className="btn-ghost w-full text-center text-[11px]"
        >
          عرض الكل ({queue.total})
        </Link>
      ) : null}
    </div>
  );
}

// ── product card ──────────────────────────────────────────────────────────────

const PRIORITY_TONE: Record<string, string> = {
  high: "bg-rose-50 text-rose-700",
  medium: "bg-amber-50 text-amber-800",
  low: "bg-[#f5ece1] text-ink",
};

function TickTickBadge({ item, available }: { item: OperationsListItem; available: boolean }) {
  const count = item.ticktickSyncedCount ?? 0;
  const [text, tone] = !available
    ? ["TickTick: غير مربوط", "bg-[#f5ece1] text-muted"]
    : count > 0
      ? [`TickTick: مُزامَن (${count})`, "bg-emerald-50 text-emerald-700"]
      : ["TickTick: غير مُزامَن", "bg-[#f5ece1] text-muted"];
  return <span className={"rounded-full px-2 py-0.5 text-[10px] " + tone}>{text}</span>;
}

function ProductCard({ item, ticktickAvailable }: { item: OperationsListItem; ticktickAvailable: boolean }) {
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
          <TickTickBadge item={item} available={ticktickAvailable} />
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

// ── unified operations queue (CI.2) ─────────────────────────────────────────

const SEVERITY_TONE: Record<IssueSeverity, string> = {
  high: "bg-rose-50 text-rose-700",
  medium: "bg-amber-50 text-amber-700",
  low: "bg-sky-50 text-sky-700",
};

function UnifiedQueueSection({
  controls,
  queueControl,
  issuePage,
  queueCounts,
  queueCapped,
}: {
  controls: OperationsControls;
  queueControl: QueueControl;
  issuePage: IssuePage;
  queueCounts: QueueCounts;
  queueCapped: boolean;
}) {
  const countFor = (key: IssueQueueKey): number =>
    key === "all" ? queueCounts.total : queueCounts[key];
  return (
    <section id="unified-queue" className="scroll-mt-28 space-y-3" dir="rtl">
      <h2 className="text-sm font-semibold text-ink">قائمة المشاكل الموحدة</h2>
      {/* queue tabs — GET links, no client JS */}
      <div className="flex flex-wrap gap-2">
        {QUEUE_VALUES.map((key) => {
          const active = key === queueControl.queue;
          return (
            <Link
              key={key}
              href={queueHref(controls, key, 1)}
              className={
                "rounded-full px-3 py-1 text-xs " +
                (active ? "bg-ink text-white" : "bg-[#f5ece1] text-muted")
              }
            >
              {QUEUE_LABELS[key]} <span className="opacity-70">({countFor(key)})</span>
            </Link>
          );
        })}
      </div>

      {queueCapped ? (
        <div className="card border-amber-200 bg-amber-50 text-[11px] text-amber-800">
          العدد كبير — تُعرض أهم النتائج فقط ضمن الحد الآمن.
        </div>
      ) : null}

      {issuePage.items.length === 0 ? (
        <div className="card text-center text-sm text-muted">لا توجد مشاكل في هذه القائمة 🎉</div>
      ) : (
        <div className="space-y-2">
          {issuePage.items.map((issue) => (
            <div key={`${issue.productId}:${issue.platform}`} className="card flex flex-wrap items-center gap-2 p-3 text-xs">
              <span className={"rounded-full px-2 py-0.5 text-[10px] " + SEVERITY_TONE[issue.severity]}>
                {ISSUE_SEVERITY_LABELS[issue.severity]}
              </span>
              <span className="font-semibold text-ink">{issue.label}</span>
              <span className="text-muted">·</span>
              <span className="text-ink">{MATRIX_STATE_LABELS[issue.state]}</span>
              <span className="text-muted">·</span>
              <span className="text-muted">{ISSUE_REASON_LABELS[issue.reason]}</span>
              <span className="text-muted">·</span>
              <span className="font-mono text-[11px] text-muted">{issue.sku ?? "—"}</span>
              {/* OPS.7 — the issue routes to its EXISTING resolver (storefront/status
                  filtered); the product page stays as a secondary escape hatch. */}
              <Link href={resolveIssueHref(issue)} className="btn-ghost ms-auto text-[11px] font-semibold text-sky-700">
                الحل ↗
              </Link>
              <Link
                href={productDetailHref(issue.productId)}
                className="btn-ghost text-[11px]"
              >
                المنتج
              </Link>
            </div>
          ))}
        </div>
      )}

      {issuePage.totalPages > 1 ? (
        <div className="flex items-center justify-between pt-1 text-xs">
          {issuePage.page > 1 ? (
            <Link href={queueHref(controls, queueControl.queue, issuePage.page - 1)} className="btn-ghost" rel="prev">السابق</Link>
          ) : <span />}
          <span className="text-muted">صفحة {issuePage.page} من {issuePage.totalPages}</span>
          {issuePage.page < issuePage.totalPages ? (
            <Link href={queueHref(controls, queueControl.queue, issuePage.page + 1)} className="btn-ghost" rel="next">التالي</Link>
          ) : <span />}
        </div>
      ) : null}
    </section>
  );
}

// ── page ────────────────────────────────────────────────────────────────────

export default function OperationsDashboard({
  kpis,
  queues,
  platformOverview,
  platformHealth,
  page,
  matchCount,
  controls,
  partial,
  shopifyAvailable,
  shopifyLastCapturedAt,
  shopifyStale,
  shopifySnapshotAvailable,
  puresoulAvailable,
  puresoulDegraded,
  puresoulLastCapturedAt,
  puresoulStale,
  talabatAvailable,
  talabatDegraded,
  talabatLastCapturedAt,
  talabatStale,
  rafeeqAvailable,
  rafeeqDegraded,
  rafeeqLastCapturedAt,
  rafeeqStale,
  ticktickAvailable,
  queueControl,
  issuePage,
  queueCounts,
  queueCapped,
}: {
  kpis: DashboardKpis;
  queues: Queue[];
  platformOverview: PlatformOverview;
  platformHealth: PlatformHealth[];
  page: OperationsPage;
  matchCount: number;
  controls: OperationsControls;
  partial: boolean;
  shopifyAvailable: boolean;
  shopifyLastCapturedAt: string | null;
  shopifyStale: boolean;
  shopifySnapshotAvailable: boolean;
  puresoulAvailable: boolean;
  puresoulDegraded: boolean;
  puresoulLastCapturedAt: string | null;
  puresoulStale: boolean;
  talabatAvailable: boolean;
  talabatDegraded: boolean;
  talabatLastCapturedAt: string | null;
  talabatStale: boolean;
  rafeeqAvailable: boolean;
  rafeeqDegraded: boolean;
  rafeeqLastCapturedAt: string | null;
  rafeeqStale: boolean;
  ticktickAvailable: boolean;
  queueControl: QueueControl;
  issuePage: IssuePage;
  queueCounts: QueueCounts;
  queueCapped: boolean;
}) {
  const hasPrev = page.page > 1;
  const hasNext = page.page < page.totalPages;

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="font-serif text-2xl font-semibold text-ink">مركز العمليات</h1>
        <p className="text-sm text-muted">جاهزية المنتجات والمهام وحالة المنصات — محسوبة من ماليكاس، المصدر الرئيسي.</p>
      </div>

      {/* In-page section nav (UX.2) — anchors only, no client JS. Reuses the
          existing #unified-queue anchor. */}
      <InPageNav
        items={[
          { href: "#kpis", label: "المؤشرات" },
          { href: "#platform-health", label: "صحة المنصات" },
          { href: "#platform-overview", label: "نظرة عامة" },
          { href: "#unified-queue", label: "المشاكل الموحدة" },
          { href: "#work-queues", label: "قوائم العمل" },
          { href: "#products", label: "المنتجات" },
        ]}
      />

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
      {shopifyAvailable && shopifySnapshotAvailable && shopifyStale ? (
        <div className="card border-amber-200 bg-amber-50 text-sm text-amber-800">
          لقطة Shopify قديمة{shopifyLastCapturedAt ? ` (آخر تحديث ${new Date(shopifyLastCapturedAt).toLocaleDateString("ar")})` : ""} — يجري تحديثها تلقائيًا عند فتح المركز.
        </div>
      ) : null}
      {puresoulDegraded ? (
        <div className="card border-amber-200 bg-amber-50 text-sm text-amber-800">
          تعذر قراءة PureSoul حاليًا — تظهر حالته «غير مربوط»، ولا تُحتسب المنتجات كغير موجودة.
        </div>
      ) : null}
      {puresoulAvailable && puresoulStale ? (
        <div className="card border-amber-200 bg-amber-50 text-sm text-amber-800">
          لقطة PureSoul قديمة{puresoulLastCapturedAt ? ` (آخر تحديث ${new Date(puresoulLastCapturedAt).toLocaleDateString("ar")})` : ""} — ارفع تصدير PureSoul جديد لتحديث الحالة.
        </div>
      ) : null}
      {talabatDegraded ? (
        <div className="card border-amber-200 bg-amber-50 text-sm text-amber-800">
          تعذر قراءة لقطات Talabat حاليًا — تظهر حالته «غير مربوط»، ولا تُحتسب المنتجات كغير موجودة.
        </div>
      ) : null}
      {talabatAvailable && talabatStale ? (
        <div className="card border-amber-200 bg-amber-50 text-sm text-amber-800">
          لقطة Talabat قديمة{talabatLastCapturedAt ? ` (آخر تحديث ${new Date(talabatLastCapturedAt).toLocaleDateString("ar")})` : ""} — ارفع تصدير Talabat جديد لتحديث الحالة.
        </div>
      ) : null}
      {rafeeqDegraded ? (
        <div className="card border-amber-200 bg-amber-50 text-sm text-amber-800">
          تعذر قراءة لقطات Rafeeq حاليًا — تظهر حالته «غير مربوط»، ولا تُحتسب المنتجات كغير موجودة.
        </div>
      ) : null}
      {rafeeqAvailable && rafeeqStale ? (
        <div className="card border-amber-200 bg-amber-50 text-sm text-amber-800">
          لقطة Rafeeq قديمة{rafeeqLastCapturedAt ? ` (آخر تحديث ${new Date(rafeeqLastCapturedAt).toLocaleDateString("ar")})` : ""} — يجري تحديثها تلقائيًا عند فتح المركز.
        </div>
      ) : null}
      {!ticktickAvailable ? (
        <div className="card border-[#efe3d6] bg-[#faf3ec] text-sm text-muted">
          TickTick غير مربوط حاليًا — تظهر المهام كـ«غير مُزامَنة»، والمركز يعمل بشكل كامل.
        </div>
      ) : null}

      {/* KPI cards — clickable filters */}
      <div id="kpis" className="scroll-mt-28 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <KpiCard label="إجمالي المنتجات" value={kpis.totalProducts} filter="all" controls={controls} />
        <KpiCard label="منتجات جديدة" value={kpis.newProducts} filter="new" controls={controls} tone="brand" />
        <KpiCard label="يحتاج صورة" value={kpis.needsImage} filter="needs_image" controls={controls} tone="amber" />
        <KpiCard label="يحتاج مراجعة" value={kpis.needsReview} filter="needs_review" controls={controls} tone="amber" />
        <KpiCard label="جاهز" value={kpis.ready} filter="ready" controls={controls} tone="emerald" />
        <KpiCard label="إجمالي المهام" value={kpis.totalTasks} filter="has_tasks" controls={controls} />
        <KpiCard label="أولوية عالية" value={kpis.highPriorityTasks} filter="high_priority" controls={controls} tone="rose" />
        <KpiCard label="متوسط الجاهزية" value={kpis.readinessAverage} suffix="%" controls={controls} />
        <KpiCard label="Shopify: غير موجود" value={kpis.shopifyMissing} filter="shopify_missing" controls={controls} tone="rose" />
        <KpiCard label="Shopify: مختلف" value={kpis.shopifyDifferent} filter="shopify_different" controls={controls} tone="amber" />
        <KpiCard label="مهام مربوطة بـ TickTick" value={kpis.ticktickLinkedTasks} filter="ticktick_synced" controls={controls} tone="emerald" />
        {puresoulAvailable ? (
          <>
            <KpiCard label="PureSoul: غير موجود" value={platformOverview.puresoul.missing} filter="puresoul_missing" controls={controls} tone="rose" />
            <KpiCard label="PureSoul: فرق سعر" value={platformOverview.puresoul.priceDifferent} filter="puresoul_price_diff" controls={controls} tone="amber" />
            <KpiCard label="PureSoul: نافد" value={platformOverview.puresoul.outOfStock} filter="puresoul_out_of_stock" controls={controls} tone="amber" />
            <KpiCard label="PureSoul: مراجعة" value={platformOverview.puresoul.reviewRequired} filter="puresoul_review" controls={controls} tone="amber" />
          </>
        ) : null}
      </div>

      {/* platform freshness + health (CI.4) — above the overview grid */}
      <div id="platform-health" className="scroll-mt-28">
        <PlatformHealthSection health={platformHealth} />
      </div>

      {/* platform overview */}
      <div id="platform-overview" className="scroll-mt-28">
        <PlatformOverviewSection overview={platformOverview} />
      </div>

      {/* unified cross-platform issue queue (CI.2) */}
      <UnifiedQueueSection
        controls={controls}
        queueControl={queueControl}
        issuePage={issuePage}
        queueCounts={queueCounts}
        queueCapped={queueCapped}
      />

      {/* queues */}
      <section id="work-queues" className="scroll-mt-28 space-y-3">
        <h2 className="text-sm font-semibold text-ink">قوائم العمل</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {queues.map((q) => <QueueCard key={q.key} queue={q} controls={controls} />)}
        </div>
      </section>

      {/* search + filter (GET form; no client JS) */}
      <form id="products" method="get" className="card scroll-mt-28 grid grid-cols-1 gap-3 p-4 sm:grid-cols-3">
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
          {kpis.totalProducts === 0 ? "لا توجد منتجات في الكتالوج." : "لا توجد نتائج مطابقة للفلتر أو البحث الحالي."}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
            <span>عرض {page.startIndex + 1}–{page.startIndex + page.items.length} من {matchCount}</span>
            <span>صفحة {page.page} من {page.totalPages}</span>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {page.items.map((item) => <ProductCard key={item.id} item={item} ticktickAvailable={ticktickAvailable} />)}
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
