"use client";

import { useEffect, useState } from "react";
import { calendarStatus, syncAllTasksToCalendar } from "@/app/(app)/tasks/actions";

// Google Calendar link card for the tasks page: shows connection status, the
// service-account email to share the calendar with, and a bulk "sync all" button.
export default function TasksCalendarCard({ locale = "ar" }: { locale?: "ar" | "en" }) {
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);

  const [status, setStatus] = useState<Awaited<ReturnType<typeof calendarStatus>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [result, setResult] = useState("");

  // load() sets state only AFTER an await, so the mount effect never setStates
  // synchronously (avoids the cascading-render warning). refresh() is for the button.
  const load = async () => {
    try { setStatus(await calendarStatus()); } catch { setStatus({ state: "error", detail: L("تعذّر الفحص.", "Check failed.") }); }
    setLoading(false);
  };
  const refresh = () => { setLoading(true); void load(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps, react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, []);

  const syncAll = async () => {
    setSyncing(true); setResult("");
    const r = await syncAllTasksToCalendar();
    setSyncing(false);
    if ("error" in r) { setResult(`⚠️ ${r.error}`); return; }
    setResult(L(
      `✅ تمّت المزامنة — ${r.synced} حدث، حُذف ${r.removed}${r.failed ? `، فشل ${r.failed}` : ""}.`,
      `✅ Synced — ${r.synced} events, ${r.removed} removed${r.failed ? `, ${r.failed} failed` : ""}.`,
    ));
    void refresh();
  };

  const state = status?.state;
  const dot = state === "connected" ? "bg-emerald-500" : state === "error" ? "bg-red-500" : "bg-slate-400";
  const label = state === "connected" ? L("متصل", "Connected") : state === "error" ? L("خطأ", "Error") : L("غير متصل", "Not connected");

  return (
    <div className="card space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-lg">📅</span>
        <span className="text-sm font-semibold text-ink">{L("ربط المهام مع Google Calendar", "Google Calendar link")}</span>
        <span className="flex items-center gap-1 text-xs text-muted">
          <span className={`inline-block h-2 w-2 rounded-full ${dot}`} />
          {loading ? L("يفحص…", "Checking…") : label}
        </span>
        <div className="ms-auto flex items-center gap-2">
          <button onClick={refresh} disabled={loading} className="btn-ghost px-2 py-1 text-xs disabled:opacity-50">↻ {L("تحديث", "Refresh")}</button>
          <button onClick={syncAll} disabled={syncing || state !== "connected"} className="btn-primary px-3 py-1 text-xs disabled:opacity-50">
            {syncing ? `⏳ ${L("يزامن…", "Syncing…")}` : `🔄 ${L("مزامنة كل المهام", "Sync all tasks")}`}
          </button>
        </div>
      </div>

      {state === "connected" ? (
        <p className="text-[11px] text-muted">{L("المهام اللي لها تاريخ استحقاق تظهر تلقائياً كأحداث في التقويم، وتتحدّث عند أي تعديل.", "Tasks with a due date appear as calendar events automatically and update on any change.")}</p>
      ) : null}

      {status?.detail ? <p className="rounded-lg bg-slate-50 px-3 py-1.5 text-[11px] text-slate-600" dir="auto">{status.detail}</p> : null}

      {state !== "connected" && status?.email ? (
        <p className="text-[11px] text-amber-800" dir="ltr">Share the calendar with <code className="rounded bg-white px-1">{status.email}</code> (Make changes to events).</p>
      ) : null}

      {state === "not_connected" ? (
        <div className="rounded-lg bg-amber-50/60 px-3 py-2 text-[11px] text-amber-800" dir="ltr">
          <p>Set in Vercel then Redeploy:</p>
          <ul className="list-disc ps-4">
            <li><code>GOOGLE_SERVICE_ACCOUNT_JSON</code> — the service-account key JSON</li>
            <li><code>GOOGLE_CALENDAR_ID</code> — the calendar id (share it with the service account)</li>
          </ul>
        </div>
      ) : null}

      {result ? <p className="text-[11px] text-emerald-700" dir="auto">{result}</p> : null}
    </div>
  );
}
