"use client";
// AI.1 — Action Center surface (§5 dashboard + §6 review drawer). Presentational
// only: it receives an already-built ActionCenterView (serializable) and renders
// the top summary lanes, source health, a search filter, and the actions grouped
// by type. Selecting an action opens the read-only Review Drawer. No data client,
// no writes, no execution.

import { useMemo, useState } from "react";
import {
  filterActions,
  groupActionsByType,
  type Action,
  type ActionCenterView,
  type ActionLane,
  type ActionSeverity,
} from "@/lib/actions/action-model";
import ReviewDrawer from "./ReviewDrawer";

const SEVERITY_DOT: Record<ActionSeverity, string> = {
  critical: "bg-red-500",
  warning: "bg-amber-500",
  info: "bg-slate-400",
};

const LANE_TILES: { lane: ActionLane; label: string; key: keyof ActionCenterView["summary"] }[] = [
  { lane: "critical", label: "حرِج", key: "critical" },
  { lane: "approval_required", label: "بحاجة لموافقة", key: "approvalRequired" },
  { lane: "auto_eligible", label: "مؤهّل للتنفيذ الآلي", key: "autoEligible" },
  { lane: "waiting", label: "بالانتظار", key: "waiting" },
  { lane: "completed", label: "أُنجز اليوم", key: "completedToday" },
];

const SOURCE_LABEL: Record<string, string> = {
  recommendation: "التوصيات",
  evidence: "الأدلة",
  ops_health: "صحة المنصة",
  analytics: "التحليلات",
  ops_media: "مركز الصور",
  ops_ai: "الذكاء الاصطناعي",
  ops_channels: "القنوات",
  missing_products: "المنتجات المفقودة",
  availability: "التوفّر",
  barcode: "الباركود",
  ecl: "الربط الخارجي",
  lifecycle: "دورة الحياة",
};

export default function ActionCenter({
  view,
  heading,
  showSummary = false,
  initialLane = null,
}: {
  view: ActionCenterView;
  heading?: string;
  showSummary?: boolean;
  /** OPS.7 — a validated deep-linked lane (e.g. /v2/actions?lane=critical). */
  initialLane?: ActionLane | null;
}) {
  const [selected, setSelected] = useState<Action | null>(null);
  const [lane, setLane] = useState<ActionLane | null>(initialLane);
  const [query, setQuery] = useState("");

  const groups = useMemo(
    () => groupActionsByType(filterActions(view.actions, { lane, query })),
    [view.actions, lane, query],
  );

  const totalShown = groups.reduce((n, g) => n + g.count, 0);

  return (
    <section className="space-y-4">
      {heading ? <h2 className="text-base font-bold text-slate-800">{heading}</h2> : null}

      {showSummary ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {LANE_TILES.map((t) => {
            const active = lane === t.lane;
            const value = view.summary[t.key];
            const placeholder = t.lane === "completed";
            return (
              <button
                key={t.lane}
                type="button"
                onClick={() => setLane(active ? null : placeholder ? null : t.lane)}
                aria-pressed={active}
                disabled={placeholder}
                className={
                  "card flex flex-col items-start gap-0.5 text-start transition " +
                  (active ? "ring-2 ring-brand" : "") +
                  (placeholder ? " opacity-60" : " hover:bg-[#faf3ec]")
                }
              >
                <span className="text-2xl font-bold text-slate-800">{value}</span>
                <span className="text-xs text-muted">{t.label}</span>
                {placeholder ? <span className="text-[10px] text-muted">(قيد التتبّع لاحقًا)</span> : null}
              </button>
            );
          })}
        </div>
      ) : null}

      {/* Source health — degraded sources are visible, never silently empty. */}
      {view.sources.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          {view.sources.map((s) => (
            <span
              key={s.source}
              className={
                "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 " +
                (s.ok ? "border-[#e7d9c9] bg-white text-muted" : "border-amber-300 bg-amber-50 text-amber-700")
              }
              title={s.ok ? "متصل" : "غير متوفّر الآن"}
            >
              <span className={"h-1.5 w-1.5 rounded-full " + (s.ok ? "bg-emerald-500" : "bg-amber-500")} />
              {SOURCE_LABEL[s.source] ?? s.source}: {s.count}
            </span>
          ))}
        </div>
      ) : null}

      <div className="flex items-center gap-2">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="بحث في الإجراءات…"
          aria-label="بحث في الإجراءات"
          className="w-full rounded-xl border border-[#e7d9c9] bg-white px-3 py-2 text-sm text-ink placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-brand"
        />
        {lane || query ? (
          <button
            type="button"
            onClick={() => {
              setLane(null);
              setQuery("");
            }}
            className="shrink-0 rounded-xl border border-[#e7d9c9] bg-white px-3 py-2 text-sm text-muted hover:bg-[#faf3ec]"
          >
            مسح
          </button>
        ) : null}
      </div>

      {groups.length === 0 ? (
        <p className="card text-sm text-muted" role="status">
          {totalShown === 0 && view.actions.length === 0
            ? "لا توجد إجراءات مطلوبة الآن."
            : "لا نتائج مطابقة للتصفية."}
        </p>
      ) : (
        <div className="space-y-4">
          {groups.map((g) => (
            <section key={g.type} className="card space-y-2">
              <div className="flex items-center gap-2">
                <span className={"h-2 w-2 rounded-full " + SEVERITY_DOT[g.severity]} aria-hidden="true" />
                <h3 className="text-sm font-bold text-slate-800">{g.label}</h3>
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
                  {g.count}
                </span>
              </div>
              <ul className="divide-y divide-[#f1e7db]">
                {g.actions.map((a) => (
                  <li key={a.id}>
                    <button
                      type="button"
                      onClick={() => setSelected(a)}
                      className="flex w-full items-center justify-between gap-3 py-2 text-start hover:bg-[#faf3ec]"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-ink">{a.title}</span>
                        <span className="block truncate text-xs text-muted">{a.reason}</span>
                      </span>
                      <span className={"h-1.5 w-1.5 shrink-0 rounded-full " + SEVERITY_DOT[a.severity]} aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      <ReviewDrawer action={selected} onClose={() => setSelected(null)} />
    </section>
  );
}
