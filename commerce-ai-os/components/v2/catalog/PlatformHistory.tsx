// Malikas V2 — «سجل المنصات» section for the product detail page (Phase UI.9.4).
// Server Component, READ-ONLY: renders the platform snapshot history already
// derived by lib/operations/platform-history-read (entries newest-first + a
// last-vs-previous comparison per platform). NO business logic, NO data access,
// NO client JS — all formatting comes from the pure history-view helpers. Only
// whitelisted fields are ever shown; raw metadata is never rendered.

import {
  changeTypeLabel,
  fieldLabel,
  formatDelta,
  formatSnapshotDate,
  formatValue,
  paginateHistory,
  platformLabel,
} from "@/lib/platforms/core/history-view";
import type {
  PlatformComparison,
  PlatformFieldDelta,
  PlatformHistoryEntry,
} from "@/lib/platforms/core/history";

const HISTORY_SHOWN = 20;

function DeltaLine({ delta }: { delta: PlatformFieldDelta }) {
  return (
    <div className="flex items-center justify-between gap-2 text-[11px]">
      <span className="text-muted">{fieldLabel(delta.field)}</span>
      <span className="font-mono text-ink">{formatDelta(delta)}</span>
    </div>
  );
}

function Comparison({ c }: { c: PlatformComparison }) {
  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink">{platformLabel(c.platform)}</h3>
        <span className="text-[11px] text-muted">{formatSnapshotDate(c.latest.capturedAt)}</span>
      </div>
      {c.previous === null ? (
        <p className="mt-1 text-[11px] text-muted">أول لقطة — لا توجد لقطة سابقة للمقارنة.</p>
      ) : c.fields.length === 0 && !c.metadataChanged ? (
        <p className="mt-1 text-[11px] text-muted">لا تغييرات منذ اللقطة السابقة.</p>
      ) : (
        <div className="mt-2 space-y-1">
          {c.fields.map((d) => (
            <DeltaLine key={d.field} delta={d} />
          ))}
          {c.metadataChanged ? (
            <div className="text-[11px] text-muted">تغيّرت بيانات إضافية.</div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function Entry({ entry }: { entry: PlatformHistoryEntry }) {
  return (
    <li className="rounded-lg border border-slate-100 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm text-ink">
          {platformLabel(entry.platform)}
          <span className="text-muted"> · {changeTypeLabel(entry.changeType)}</span>
        </div>
        <span className="shrink-0 text-[11px] text-muted">{formatSnapshotDate(entry.capturedAt)}</span>
      </div>
      {entry.fields.length > 0 ? (
        <div className="mt-1.5 space-y-1">
          {entry.fields.map((d) => (
            <div key={d.field} className="flex items-center justify-between gap-2 text-[11px]">
              <span className="text-muted">{fieldLabel(d.field)}</span>
              <span className="font-mono text-ink">
                {entry.changeType === "created" ? formatValue(d.after) : formatDelta(d)}
              </span>
            </div>
          ))}
        </div>
      ) : null}
      {entry.metadataChanged ? (
        <div className="mt-1 text-[11px] text-muted">تغيّرت بيانات إضافية.</div>
      ) : null}
    </li>
  );
}

export default function PlatformHistory({
  entries,
  comparisons,
}: {
  entries: readonly PlatformHistoryEntry[];
  comparisons: readonly PlatformComparison[];
}) {
  const isEmpty = entries.length === 0 && comparisons.length === 0;
  const { items, total } = paginateHistory(entries, 1, HISTORY_SHOWN);
  const remaining = Math.max(0, total - items.length);

  return (
    <section className="card space-y-3 p-4">
      <h2 className="text-sm font-semibold text-ink">سجل المنصات</h2>

      {isEmpty ? (
        <p className="text-sm text-muted">لا يوجد سجل منصات بعد لهذا المنتج.</p>
      ) : (
        <>
          {comparisons.length > 0 ? (
            <div className="space-y-2">
              <h3 className="text-xs font-medium text-muted">آخر لقطة مقارنة بالسابقة</h3>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {comparisons.map((c) => (
                  <Comparison key={`${c.platform}:${c.productId ?? ""}`} c={c} />
                ))}
              </div>
            </div>
          ) : null}

          {items.length > 0 ? (
            <div className="space-y-2">
              <h3 className="text-xs font-medium text-muted">السجل ({total})</h3>
              <ul className="space-y-2">
                {items.map((e) => (
                  <Entry key={`${e.platform}:${e.changeType}:${e.capturedAt}`} entry={e} />
                ))}
              </ul>
              {remaining > 0 ? (
                <p className="text-[11px] text-muted">+{remaining} حدث أقدم</p>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
