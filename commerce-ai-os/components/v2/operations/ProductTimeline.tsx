// Malikas V2 Product Timeline (Phase UI.7.4). Server Component: NO business
// logic here — it renders the activity events already COMPUTED by the
// lib/operations/timeline engine and filtered/searched by the reader. Events
// are never stored and never manually edited; the only actions are a GET form
// (filter/search, no client JS) and links back to the product. Arabic RTL,
// mobile-first cards, a vertical timeline rail.

import Link from "next/link";
import {
  TIMELINE_FILTER_LABELS,
  TIMELINE_FILTER_VALUES,
  TIMELINE_ICONS,
  TIMELINE_KIND_LABELS,
  formatTimelineDate,
  type TimelineControls,
  type TimelineFilter,
  type TimelineSummary,
} from "@/lib/operations/timeline/timeline-view";
import type { TimelineEvent, TimelineEventKind } from "@/lib/operations/shared/models";

function timelineHref(
  productId: string,
  controls: TimelineControls,
  over: Partial<TimelineControls>,
): string {
  const c = { ...controls, ...over };
  const p = new URLSearchParams();
  if (c.query) p.set("query", c.query);
  if (c.filter !== "all") p.set("filter", c.filter);
  const qs = p.toString();
  const base = `/v2/products/${encodeURIComponent(productId)}/timeline`;
  return qs ? `${base}?${qs}` : base;
}

// Purely-decorative glyph per icon key (single-sourced in TIMELINE_ICONS).
// aria-hidden — the kind label + title carry the meaning for screen readers.
const ICON_GLYPH: Record<string, string> = {
  created: "➕",
  updated: "✏️",
  approved: "✅",
  rejected: "⛔",
  ai: "🤖",
  published: "🚀",
};

const KIND_TONE: Partial<Record<TimelineEventKind, string>> = {
  created: "bg-[#f5ece1] text-ink",
  updated: "bg-amber-50 text-amber-800",
  approved: "bg-emerald-50 text-emerald-700",
  rejected: "bg-rose-50 text-rose-700",
  sent_to_ai: "bg-indigo-50 text-indigo-700",
  published: "bg-sky-50 text-sky-700",
};

function EventCard({ event }: { event: TimelineEvent }) {
  const glyph = ICON_GLYPH[TIMELINE_ICONS[event.kind] ?? ""] ?? "•";
  return (
    <div className="card space-y-2 p-3">
      <div className="flex items-start gap-3">
        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#faf3ec] text-lg"
          aria-hidden="true"
        >
          {glyph}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <span className="min-w-0 text-sm font-semibold text-ink">{event.title}</span>
            <span className={"shrink-0 rounded-full px-2 py-0.5 text-[11px] " + (KIND_TONE[event.kind] ?? "bg-[#f5ece1] text-ink")}>
              {TIMELINE_KIND_LABELS[event.kind] ?? event.kind}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-muted">{event.description}</p>
          <div className="mt-1 text-[11px] text-muted">
            {event.atKnown ? (
              <span>{formatTimelineDate(event.at)}</span>
            ) : (
              <span>حتى {formatTimelineDate(event.at)} (وقت التغيير غير مسجّل بدقة)</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ProductTimeline({
  productId,
  productName,
  backHref,
  events,
  summary,
  controls,
  matchCount,
}: {
  productId: string;
  productName: string;
  backHref: string;
  events: readonly TimelineEvent[];
  summary: TimelineSummary;
  controls: TimelineControls;
  matchCount: number;
}) {
  return (
    <div className="space-y-5">
      <Link href={backHref} className="btn-ghost">
        رجوع للمنتج
      </Link>

      <div className="space-y-1">
        <h1 className="font-serif text-2xl font-semibold text-ink">سجل النشاط</h1>
        <p className="text-sm text-muted">
          أحداث محسوبة تلقائيًا من بيانات المنتج «{productName}» — لا تُحفظ ولا تُعدّل يدويًا.
        </p>
      </div>

      {/* search + filter (GET form; no client JS) */}
      <form method="get" className="card grid grid-cols-1 gap-3 p-4 sm:grid-cols-3">
        <label className="flex flex-col gap-1 sm:col-span-2">
          <span className="label">بحث في الأحداث</span>
          <input
            type="search"
            name="query"
            defaultValue={controls.query}
            maxLength={80}
            className="input"
            placeholder="ابحث في عنوان الحدث أو وصفه"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="label">الفلتر</span>
          <select name="filter" defaultValue={controls.filter} className="select-input">
            {TIMELINE_FILTER_VALUES.map((f: TimelineFilter) => (
              <option key={f} value={f}>
                {TIMELINE_FILTER_LABELS[f]}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-center gap-2 sm:col-span-3">
          <button type="submit" className="btn-primary">
            تطبيق
          </button>
          <Link href={timelineHref(productId, controls, { query: "", filter: "all" })} className="btn-ghost">
            مسح
          </Link>
        </div>
      </form>

      {/* results */}
      {matchCount === 0 ? (
        <div className="card text-center text-sm text-muted">
          {summary.total === 0
            ? "لا يوجد نشاط مسجّل على هذا المنتج حاليًا"
            : "لا توجد أحداث مطابقة للفلتر أو البحث الحالي."}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
            <span>عرض {matchCount} من {summary.total} حدث</span>
            <span>الأحدث أولًا</span>
          </div>
          <div className="space-y-3 border-r-2 border-[#f1e6d8] pr-3">
            {events.map((e) => (
              <EventCard key={e.id} event={e} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
