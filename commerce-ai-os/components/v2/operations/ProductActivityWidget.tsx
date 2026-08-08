// Malikas V2 — «النشاط» widget for the product detail page (Phase UI.7.4).
// Read-only: it renders the timeline events already COMPUTED by
// lib/operations/timeline for this one product (latest 10 + a "+N" hint) plus a
// link to the full timeline. Events arrive newest-first from the engine, so the
// first 10 ARE the latest 10. No business logic, no data access, no edit/delete
// — activity is computed from the product snapshot, never stored.

import Link from "next/link";
import {
  timelineWidgetEvents,
  formatTimelineDate,
  TIMELINE_KIND_LABELS,
} from "@/lib/operations/timeline/timeline-view";
import type { TimelineEvent } from "@/lib/operations/shared/models";

export default function ProductActivityWidget({
  events,
  productId,
}: {
  events: readonly TimelineEvent[];
  productId: string;
}) {
  const timelineHref = `/v2/products/${encodeURIComponent(productId)}/timeline`;

  if (!events || events.length === 0) {
    return (
      <div className="card space-y-2 p-4">
        <h2 className="text-sm font-semibold text-ink">النشاط</h2>
        <p className="text-sm text-muted">لا يوجد نشاط مسجّل على هذا المنتج حاليًا.</p>
      </div>
    );
  }

  const { shown, remaining } = timelineWidgetEvents(events, 10);

  return (
    <div className="card space-y-2 p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-ink">النشاط ({events.length})</h2>
        <Link href={timelineHref} className="text-xs text-brand hover:underline">
          السجل الكامل
        </Link>
      </div>
      <ul className="space-y-2">
        {shown.map((e) => (
          <li key={e.id} className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <div className="text-sm text-ink">
                {e.title}
                <span className="text-muted"> · {TIMELINE_KIND_LABELS[e.kind]}</span>
              </div>
              {e.description ? <div className="text-[11px] text-muted">{e.description}</div> : null}
            </div>
            <span className="shrink-0 text-[11px] text-muted">
              {e.atKnown ? formatTimelineDate(e.at) : `حتى ${formatTimelineDate(e.at)}`}
            </span>
          </li>
        ))}
      </ul>
      {remaining > 0 ? (
        <Link href={timelineHref} className="block text-xs text-muted hover:underline">
          +{remaining} حدث آخر
        </Link>
      ) : null}
    </div>
  );
}
