"use client";

import { useEffect, useState, useTransition } from "react";
import { weeklyTaskReport, type WeeklyReport } from "@/app/(app)/tasks/actions";
import { type Locale } from "@/lib/i18n";

// Owner's weekly staff performance card on /tasks: last 7 days vs the 7
// before — per-employee done/late/open/overdue and average completion time.

export default function WeeklyTaskReport({ locale = "ar" }: { locale?: Locale }) {
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);
  const [cur, setCur] = useState<WeeklyReport | null>(null);
  const [prev, setPrev] = useState<WeeklyReport | null>(null);
  const [err, setErr] = useState("");
  const [, start] = useTransition();

  useEffect(() => {
    let alive = true;
    (async () => {
      const r = await weeklyTaskReport();
      if (!alive) return;
      if (r.error) { setErr(r.error); return; }
      setCur(r.current); setPrev(r.previous);
    })();
    return () => { alive = false; };
  }, []);

  const refresh = () => start(async () => {
    const r = await weeklyTaskReport();
    if (r.error) { setErr(r.error); return; }
    setCur(r.current); setPrev(r.previous);
  });

  const delta = (now: number, before: number) => {
    const d = now - before;
    if (d === 0) return <span className="text-[10px] text-slate-400">＝</span>;
    return d > 0
      ? <span className="text-[10px] font-bold text-emerald-600">▲{d}</span>
      : <span className="text-[10px] font-bold text-red-500">▼{Math.abs(d)}</span>;
  };

  const fmtH = (h: number | null) => {
    if (h == null) return "—";
    if (h < 1) return L(`${Math.round(h * 60)} دقيقة`, `${Math.round(h * 60)}m`);
    if (h < 48) return L(`${h} ساعة`, `${h}h`);
    return L(`${Math.round((h / 24) * 10) / 10} يوم`, `${Math.round((h / 24) * 10) / 10}d`);
  };

  const prevOf = (id: string) => prev?.members.find((m) => m.id === id);
  const active = (cur?.members ?? []).filter((m) => {
    const p = prevOf(m.id);
    return m.done || m.open || m.overdue || (p?.done ?? 0) > 0;
  });

  return (
    <div className="card space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-ink">📊 {L("تقرير الأسبوع — إنجاز الموظفين", "This week — staff performance")}</h3>
          <p className="text-xs text-muted">{L("آخر ٧ أيام مقارنة بالأسبوع اللي قبله. ▲▼ = الفرق عن الأسبوع الماضي.", "Last 7 days vs the 7 before. ▲▼ = change vs last week.")}</p>
        </div>
        <button type="button" onClick={refresh} className="btn-ghost shrink-0 px-3 py-1 text-xs">↻ {L("حدّث", "Refresh")}</button>
      </div>

      {err ? <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{err}</p> : null}
      {!cur && !err ? <p className="py-3 text-center text-xs text-slate-400">{L("جاري التحميل…", "Loading…")}</p> : null}

      {cur && prev ? (
        <>
          <div className="grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
            {([
              [L("منجزة", "Done"), cur.totals.done, prev.totals.done, "text-emerald-700"],
              [L("جديدة", "Created"), cur.totals.created, prev.totals.created, "text-ink"],
              [L("مفتوحة الآن", "Open now"), cur.totals.open, null, "text-brand"],
              [L("متأخّرة", "Overdue"), cur.totals.overdue, null, cur.totals.overdue > 0 ? "text-red-600" : "text-ink"],
            ] as [string, number, number | null, string][]).map(([label, n, before, cls]) => (
              <div key={label} className="rounded-xl bg-[#faf6f0] p-2.5">
                <div className={`text-xl font-extrabold ${cls}`}>{n} {before != null ? delta(n, before) : null}</div>
                <div className="text-[11px] text-muted">{label}</div>
              </div>
            ))}
          </div>

          {active.length === 0 ? (
            <p className="py-2 text-center text-xs text-slate-400">{L("ما في نشاط مهام هذا الأسبوع.", "No task activity this week.")}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-[#efe3d6] text-muted">
                    <th className="py-1.5 text-start font-semibold">{L("الموظف", "Employee")}</th>
                    <th className="py-1.5 text-center font-semibold">✓ {L("منجزة", "Done")}</th>
                    <th className="py-1.5 text-center font-semibold">⏱️ {L("متوسط الإنجاز", "Avg time")}</th>
                    <th className="py-1.5 text-center font-semibold">🐢 {L("متأخر التسليم", "Late")}</th>
                    <th className="py-1.5 text-center font-semibold">📂 {L("مفتوحة", "Open")}</th>
                    <th className="py-1.5 text-center font-semibold">🔴 {L("متأخّرة", "Overdue")}</th>
                  </tr>
                </thead>
                <tbody>
                  {active.map((m) => (
                    <tr key={m.id} className="border-b border-[#f6efe4]">
                      <td className="py-2 font-semibold text-ink">{m.name}</td>
                      <td className="py-2 text-center font-bold text-emerald-700">{m.done} {delta(m.done, prevOf(m.id)?.done ?? 0)}</td>
                      <td className="py-2 text-center text-muted">{fmtH(m.avgHours)}</td>
                      <td className={`py-2 text-center ${m.late ? "font-bold text-amber-700" : "text-muted"}`}>{m.late || "—"}</td>
                      <td className="py-2 text-center text-muted">{m.open || "—"}</td>
                      <td className={`py-2 text-center ${m.overdue ? "font-bold text-red-600" : "text-muted"}`}>{m.overdue || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
