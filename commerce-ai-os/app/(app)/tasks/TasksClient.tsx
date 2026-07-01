"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createTask, updateTask, deleteTask, type StaffTask, type TaskPriority, type TaskStatus } from "./actions";
import type { Locale } from "@/lib/i18n";

const PRIO: { v: TaskPriority; ar: string; en: string; dot: string }[] = [
  { v: "high", ar: "عالية", en: "High", dot: "🔴" },
  { v: "normal", ar: "عادية", en: "Normal", dot: "🟡" },
  { v: "low", ar: "منخفضة", en: "Low", dot: "⚪" },
];

function isOverdue(t: StaffTask) {
  if (!t.dueDate || t.status === "done") return false;
  const d = new Date(t.dueDate + "T23:59:59");
  return !Number.isNaN(d.getTime()) && d.getTime() < Date.now();
}

export default function TasksClient({ initialTasks, staff, locale = "ar" }: {
  initialTasks: StaffTask[]; staff: { id: string; name: string }[]; locale?: Locale;
}) {
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);
  const router = useRouter();
  const [tasks, setTasks] = useState(initialTasks);
  const [tab, setTab] = useState<"open" | "done">("open");
  const [busy, start] = useTransition();
  const [note, setNote] = useState("");

  // form
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [assignee, setAssignee] = useState(""); // "" = everyone
  const [priority, setPriority] = useState<TaskPriority>("normal");
  const [due, setDue] = useState("");

  const flash = (t: string) => { setNote(t); setTimeout(() => setNote(""), 3000); };
  const refresh = () => router.refresh();

  const add = () => {
    if (!title.trim()) { flash(L("اكتب عنوان المهمة.", "Enter a task title.")); return; }
    const name = staff.find((s) => s.id === assignee)?.name ?? null;
    start(async () => {
      const r = await createTask({ title, description: desc, assignedTo: assignee || null, assignedName: name, priority, dueDate: due || null });
      if (r && "error" in r && r.error) { flash(r.error); return; }
      flash(L("✓ أُضيفت المهمة", "✓ Task added"));
      setTitle(""); setDesc(""); setAssignee(""); setPriority("normal"); setDue("");
      refresh();
    });
  };

  const setStatus = (t: StaffTask, status: TaskStatus) => start(async () => {
    const r = await updateTask(t.id, { status });
    if (r && "error" in r && r.error) { flash(r.error); return; }
    setTasks((ts) => ts.map((x) => (x.id === t.id ? { ...x, status } : x)));
  });

  const remove = (t: StaffTask) => {
    if (!confirm(L(`حذف المهمة «${t.title}»؟`, `Delete task "${t.title}"?`))) return;
    start(async () => {
      const r = await deleteTask(t.id);
      if (r && "error" in r && r.error) { flash(r.error); return; }
      setTasks((ts) => ts.filter((x) => x.id !== t.id));
    });
  };

  const open = useMemo(() => tasks.filter((t) => t.status !== "done"), [tasks]);
  const done = useMemo(() => tasks.filter((t) => t.status === "done"), [tasks]);
  const shown = tab === "open" ? open : done;

  const prioOf = (p: TaskPriority) => PRIO.find((x) => x.v === p) ?? PRIO[1];
  const fmt = (s: string | null) => {
    if (!s) return "";
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(locale, { day: "2-digit", month: "short" });
  };

  return (
    <div className="space-y-4">
      {/* create form */}
      <div className="card space-y-2">
        <p className="text-sm font-semibold text-ink">{L("+ مهمة جديدة", "+ New task")}</p>
        <input className="input w-full" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={L("عنوان المهمة", "Task title")} />
        <textarea className="input w-full" rows={2} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder={L("وصف (اختياري)", "Description (optional)")} />
        <div className="flex flex-wrap gap-2">
          <label className="flex-1 text-xs text-muted">{L("مكلّف", "Assignee")}
            <select className="input mt-1 w-full" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
              <option value="">{L("👥 الكل", "👥 Everyone")}</option>
              {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <label className="text-xs text-muted">{L("الأولوية", "Priority")}
            <select className="input mt-1" value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)}>
              {PRIO.map((p) => <option key={p.v} value={p.v}>{p.dot} {en ? p.en : p.ar}</option>)}
            </select>
          </label>
          <label className="text-xs text-muted">{L("الاستحقاق", "Due")}
            <input type="date" className="input mt-1" value={due} onChange={(e) => setDue(e.target.value)} />
          </label>
        </div>
        <button onClick={add} disabled={busy || !title.trim()} className="btn-primary px-4 py-2 text-sm disabled:opacity-50">{L("إضافة", "Add")}</button>
        {note ? <p className="text-xs text-emerald-700">{note}</p> : null}
      </div>

      {/* tabs */}
      <div className="flex items-center gap-1 rounded-lg border border-slate-200 p-0.5">
        <button onClick={() => setTab("open")} className={`rounded-md px-3 py-1.5 text-sm font-medium ${tab === "open" ? "bg-violet-600 text-white" : "text-slate-600"}`}>{L("مفتوحة", "Open")} ({open.length})</button>
        <button onClick={() => setTab("done")} className={`rounded-md px-3 py-1.5 text-sm font-medium ${tab === "done" ? "bg-violet-600 text-white" : "text-slate-600"}`}>{L("منجزة", "Done")} ({done.length})</button>
      </div>

      {shown.length === 0 ? (
        <div className="card py-8 text-center text-sm text-slate-400">{tab === "open" ? L("ما فيه مهام مفتوحة.", "No open tasks.") : L("ما فيه مهام منجزة.", "No completed tasks.")}</div>
      ) : (
        <div className="space-y-2">
          {shown.map((t) => {
            const p = prioOf(t.priority);
            const overdue = isOverdue(t);
            return (
              <div key={t.id} className={`rounded-xl border p-3 ${overdue ? "border-red-200 bg-red-50" : "border-slate-200 bg-white"}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className={`text-sm font-medium ${t.status === "done" ? "text-slate-400 line-through" : "text-ink"}`}>{p.dot} {t.title}</p>
                    {t.description ? <p className="mt-0.5 text-xs text-muted">{t.description}</p> : null}
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted">
                      <span>👤 {t.assignedName ?? L("الكل", "Everyone")}</span>
                      {t.dueDate ? <span className={overdue ? "font-bold text-red-600" : ""}>· ⏰ {fmt(t.dueDate)}{overdue ? L(" (متأخّرة)", " (overdue)") : ""}</span> : null}
                      {t.status === "in_progress" ? <span className="rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-700">{L("جاري", "In progress")}</span> : null}
                      {t.status === "done" && t.completedAt ? <span className="text-emerald-600">· ✓ {fmt(t.completedAt)}{t.completedBy ? ` · ${t.completedBy.replace(/^staff:/, "")}` : ""}</span> : null}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    {t.status !== "done" ? (
                      <button disabled={busy} onClick={() => setStatus(t, "done")} className="rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-bold text-white disabled:opacity-50">{L("✓ تم", "✓ Done")}</button>
                    ) : (
                      <button disabled={busy} onClick={() => setStatus(t, "open")} className="rounded-md border border-slate-200 px-2.5 py-1 text-xs text-slate-600 disabled:opacity-50">{L("↺ إعادة فتح", "↺ Reopen")}</button>
                    )}
                    <button disabled={busy} onClick={() => remove(t)} className="rounded-md border border-red-200 px-2.5 py-1 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50">{L("حذف", "Delete")}</button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
