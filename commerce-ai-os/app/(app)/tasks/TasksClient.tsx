"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createTask, updateTask, deleteTask, managerListComments, managerAddComment, createRoutine, setRoutineActive, deleteRoutine, type StaffTask, type TaskPriority, type TaskStatus } from "./actions";
import type { Routine } from "@/lib/tasks/routines";
import TaskThread from "@/components/TaskThread";
import type { Locale } from "@/lib/i18n";

const PRIO: Record<TaskPriority, { ar: string; en: string; dot: string; bar: string; chip: string }> = {
  high:   { ar: "عالية",   en: "High",   dot: "🔴", bar: "bg-red-500",    chip: "bg-red-50 text-red-700" },
  normal: { ar: "عادية",   en: "Normal", dot: "🟡", bar: "bg-amber-400",  chip: "bg-amber-50 text-amber-700" },
  low:    { ar: "منخفضة",  en: "Low",    dot: "⚪", bar: "bg-slate-300",  chip: "bg-slate-100 text-slate-500" },
};

function isOverdue(t: StaffTask) {
  if (!t.dueDate || t.status === "done") return false;
  const d = new Date(t.dueDate + "T23:59:59");
  return !Number.isNaN(d.getTime()) && d.getTime() < Date.now();
}

export default function TasksClient({ initialTasks, staff, locale = "ar", initialRoutines = [], routinesReady = true }: {
  initialTasks: StaffTask[]; staff: { id: string; name: string }[]; locale?: Locale;
  initialRoutines?: Routine[]; routinesReady?: boolean;
}) {
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);
  const router = useRouter();
  const [tasks, setTasks] = useState(initialTasks);
  const [tab, setTab] = useState<"open" | "done">("open");
  const [fAssignee, setFAssignee] = useState("");
  const [fPriority, setFPriority] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [showRoutines, setShowRoutines] = useState(false);
  const [routines, setRoutines] = useState<Routine[]>(initialRoutines);
  const [busy, start] = useTransition();
  const [note, setNote] = useState("");

  // form
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [assignee, setAssignee] = useState("");
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
      setTitle(""); setDesc(""); setAssignee(""); setPriority("normal"); setDue(""); setShowForm(false);
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

  // routines
  const [rTitle, setRTitle] = useState("");
  const [rAssignee, setRAssignee] = useState("");
  const [rPriority, setRPriority] = useState<TaskPriority>("normal");
  const [rFreq, setRFreq] = useState<"daily" | "weekly">("daily");
  const [rWeekday, setRWeekday] = useState(0);

  const WEEKDAYS = [
    L("الأحد", "Sunday"), L("الاثنين", "Monday"), L("الثلاثاء", "Tuesday"), L("الأربعاء", "Wednesday"),
    L("الخميس", "Thursday"), L("الجمعة", "Friday"), L("السبت", "Saturday"),
  ];

  const addRoutine = () => {
    if (!rTitle.trim()) { flash(L("اكتب عنوان الروتين.", "Enter a routine title.")); return; }
    const name = staff.find((s) => s.id === rAssignee)?.name ?? null;
    start(async () => {
      const r = await createRoutine({ title: rTitle, assignedTo: rAssignee || null, assignedName: name, priority: rPriority, frequency: rFreq, weekday: rFreq === "weekly" ? rWeekday : null });
      if (r && "error" in r && r.error) { flash(r.error); return; }
      flash(L("✓ أُنشئ الروتين — مهمة اليوم تولّدت", "✓ Routine created — today's task generated"));
      setRTitle(""); setRAssignee(""); setRPriority("normal"); setRFreq("daily"); setRWeekday(0);
      refresh();
    });
  };

  const toggleRoutine = (r: Routine) => start(async () => {
    const res = await setRoutineActive(r.id, !r.active);
    if (res && "error" in res && res.error) { flash(res.error); return; }
    setRoutines((rs) => rs.map((x) => (x.id === r.id ? { ...x, active: !x.active } : x)));
  });

  const removeRoutine = (r: Routine) => {
    if (!confirm(L(`حذف الروتين «${r.title}»؟ (تنحذف مهامه المولّدة أيضًا)`, `Delete routine "${r.title}"? (its generated tasks are removed too)`))) return;
    start(async () => {
      const res = await deleteRoutine(r.id);
      if (res && "error" in res && res.error) { flash(res.error); return; }
      setRoutines((rs) => rs.filter((x) => x.id !== r.id));
      refresh();
    });
  };

  const open = useMemo(() => tasks.filter((t) => t.status !== "done"), [tasks]);
  const done = useMemo(() => tasks.filter((t) => t.status === "done"), [tasks]);
  const overdue = useMemo(() => open.filter(isOverdue).length, [open]);
  const inProgress = useMemo(() => open.filter((t) => t.status === "in_progress").length, [open]);

  const base = tab === "open" ? open : done;
  const shown = base.filter((t) =>
    (!fAssignee || (fAssignee === "__all" ? t.assignedTo == null : t.assignedTo === fAssignee)) &&
    (!fPriority || t.priority === fPriority)
  );

  const fmt = (s: string | null) => {
    if (!s) return "";
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(locale, { day: "2-digit", month: "short" });
  };
  const initial = (name: string | null) => (name ? name.trim().slice(0, 1) : "");

  return (
    <div className="space-y-4">
      {/* summary tiles */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label={L("📋 مفتوحة", "📋 Open")} value={open.length} color="text-brand" />
        <Tile label={L("🔴 متأخّرة", "🔴 Overdue")} value={overdue} color="text-red-600" danger={overdue > 0} />
        <Tile label={L("⏳ جاري", "⏳ In progress")} value={inProgress} color="text-amber-600" />
        <Tile label={L("✓ منجزة", "✓ Done")} value={done.length} color="text-emerald-600" />
      </div>

      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-xl bg-slate-100 p-1">
          <button onClick={() => setTab("open")} className={`rounded-lg px-3 py-1.5 text-sm font-semibold ${tab === "open" ? "bg-white text-ink shadow-xs" : "text-slate-500"}`}>{L("مفتوحة", "Open")} ({open.length})</button>
          <button onClick={() => setTab("done")} className={`rounded-lg px-3 py-1.5 text-sm font-semibold ${tab === "done" ? "bg-white text-ink shadow-xs" : "text-slate-500"}`}>{L("منجزة", "Done")} ({done.length})</button>
        </div>
        <select className="input max-w-44 text-sm" value={fAssignee} onChange={(e) => setFAssignee(e.target.value)}>
          <option value="">{L("👥 كل الموظفين", "👥 All staff")}</option>
          <option value="__all">{L("👥 مهام للكل", "👥 Everyone tasks")}</option>
          {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select className="input max-w-40 text-sm" value={fPriority} onChange={(e) => setFPriority(e.target.value)}>
          <option value="">{L("كل الأولويات", "All priorities")}</option>
          <option value="high">🔴 {L("عالية", "High")}</option>
          <option value="normal">🟡 {L("عادية", "Normal")}</option>
          <option value="low">⚪ {L("منخفضة", "Low")}</option>
        </select>
        <div className="ms-auto flex items-center gap-2">
          <button onClick={() => setShowRoutines((v) => !v)} className="btn-ghost px-3 py-2 text-sm">🔁 {L("الروتين", "Routines")} ({routines.filter((r) => r.active).length})</button>
          <button onClick={() => setShowForm((v) => !v)} className="btn-primary px-4 py-2 text-sm">{showForm ? L("× إغلاق", "× Close") : L("+ مهمة جديدة", "+ New task")}</button>
        </div>
      </div>

      {/* routines panel */}
      {showRoutines ? (
        <div className="card space-y-3 border-brand/30">
          <p className="font-serif text-sm font-bold text-ink">🔁 {L("الروتين المتكرّر", "Recurring routines")}</p>
          {!routinesReady ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              {L("شغّل", "Run")} <code className="rounded-sm bg-white px-1">supabase/task_routines.sql</code> {L("مرة وحدة في Supabase ثم حدّث.", "once in Supabase, then refresh.")}
            </div>
          ) : (
            <>
              <p className="text-xs text-muted">{L("مهمة تتولّد تلقائيًا كل يوم أو كل أسبوع (مثل تشيك-ليست الافتتاح).", "A task auto-generates every day or week (e.g. an opening checklist).")}</p>
              <div className="flex flex-wrap items-end gap-2">
                <input className="input flex-1 min-w-48" value={rTitle} onChange={(e) => setRTitle(e.target.value)} placeholder={L("مثال: ترتيب الرفوف وفتح المتجر", "e.g. Tidy shelves & open the store")} />
                <select className="input max-w-40" value={rAssignee} onChange={(e) => setRAssignee(e.target.value)}>
                  <option value="">{L("👥 الكل", "👥 Everyone")}</option>
                  {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                <select className="input" value={rPriority} onChange={(e) => setRPriority(e.target.value as TaskPriority)}>
                  <option value="high">🔴 {L("عالية", "High")}</option>
                  <option value="normal">🟡 {L("عادية", "Normal")}</option>
                  <option value="low">⚪ {L("منخفضة", "Low")}</option>
                </select>
                <select className="input" value={rFreq} onChange={(e) => setRFreq(e.target.value as "daily" | "weekly")}>
                  <option value="daily">{L("يوميًا", "Daily")}</option>
                  <option value="weekly">{L("أسبوعيًا", "Weekly")}</option>
                </select>
                {rFreq === "weekly" ? (
                  <select className="input" value={rWeekday} onChange={(e) => setRWeekday(Number(e.target.value))}>
                    {WEEKDAYS.map((d, i) => <option key={i} value={i}>{d}</option>)}
                  </select>
                ) : null}
                <button onClick={addRoutine} disabled={busy || !rTitle.trim()} className="btn-primary px-4 py-2 text-sm disabled:opacity-50">{L("إضافة", "Add")}</button>
              </div>
              {routines.length === 0 ? (
                <p className="text-xs text-slate-400">{L("ما فيه روتين بعد.", "No routines yet.")}</p>
              ) : (
                <div className="space-y-1.5">
                  {routines.map((r) => (
                    <div key={r.id} className={`flex items-center gap-2 rounded-lg border border-[#efe3d6] bg-white px-3 py-2 ${r.active ? "" : "opacity-60"}`}>
                      <span className="text-sm">🔁</span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-ink">{r.title}</span>
                        <span className="block text-[11px] text-muted">
                          {r.frequency === "daily" ? L("يوميًا", "Daily") : `${L("أسبوعيًا —", "Weekly —")} ${WEEKDAYS[r.weekday ?? 0]}`} · {r.assignedName ?? L("الكل", "Everyone")}
                        </span>
                      </span>
                      <button disabled={busy} onClick={() => toggleRoutine(r)} className="shrink-0 rounded-md border border-[#e7d9c9] px-2 py-1 text-[11px] text-[#8a7461] hover:bg-violet-50 disabled:opacity-50">{r.active ? L("إيقاف", "Pause") : L("تفعيل", "Resume")}</button>
                      <button disabled={busy} onClick={() => removeRoutine(r)} className="shrink-0 rounded-md border border-red-200 px-2 py-1 text-[11px] text-red-600 hover:bg-red-50 disabled:opacity-50">{L("حذف", "Delete")}</button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      ) : null}

      {note ? <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">{note}</div> : null}

      {/* create form (collapsible) */}
      {showForm ? (
        <div className="card space-y-2 border-violet-200">
          <input className="input w-full" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={L("عنوان المهمة", "Task title")} autoFocus />
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
                <option value="high">🔴 {L("عالية", "High")}</option>
                <option value="normal">🟡 {L("عادية", "Normal")}</option>
                <option value="low">⚪ {L("منخفضة", "Low")}</option>
              </select>
            </label>
            <label className="text-xs text-muted">{L("الاستحقاق", "Due")}
              <input type="date" className="input mt-1" value={due} onChange={(e) => setDue(e.target.value)} />
            </label>
          </div>
          <button onClick={add} disabled={busy || !title.trim()} className="btn-primary px-4 py-2 text-sm disabled:opacity-50">{L("إضافة المهمة", "Add task")}</button>
        </div>
      ) : null}

      {/* list */}
      {shown.length === 0 ? (
        <div className="card py-10 text-center text-sm text-slate-400">{tab === "open" ? L("ما فيه مهام مفتوحة 🎉", "No open tasks 🎉") : L("ما فيه مهام منجزة.", "No completed tasks.")}</div>
      ) : tab === "done" ? (
        <div className="space-y-1.5">
          {shown.map((t) => (
            <div key={t.id} className="flex items-center gap-2 rounded-lg border border-slate-100 bg-white px-3 py-2">
              <span className="min-w-0 flex-1 truncate text-sm text-slate-400 line-through">✓ {t.title}</span>
              <span className="shrink-0 text-[11px] text-slate-400">{(t.assignedName ?? L("الكل", "Everyone"))}{t.completedAt ? ` · ${fmt(t.completedAt)}` : ""}</span>
              <button disabled={busy} onClick={() => setStatus(t, "open")} className="shrink-0 rounded-md border border-slate-200 px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-50 disabled:opacity-50">{L("↺ فتح", "↺ Reopen")}</button>
              <button disabled={busy} onClick={() => remove(t)} className="shrink-0 rounded-md border border-red-200 px-2 py-1 text-[11px] text-red-600 hover:bg-red-50 disabled:opacity-50">{L("حذف", "Delete")}</button>
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-2.5">
          {shown.map((t) => {
            const p = PRIO[t.priority];
            const od = isOverdue(t);
            const everyone = t.assignedTo == null;
            return (
              <div key={t.id} className={`relative overflow-hidden rounded-xl border p-3 ps-4 ${od ? "border-red-200 bg-red-50" : "border-slate-200 bg-white"}`}>
                <span className={`absolute inset-y-0 inset-s-0 w-1.5 ${p.bar}`} />
                <div className="flex items-stretch gap-3">
                  <span className={`flex h-10 w-10 shrink-0 items-center justify-center self-center rounded-full text-sm font-bold ${everyone ? "bg-slate-100 text-slate-500" : "bg-violet-100 text-violet-700"}`}>
                    {everyone ? "👥" : initial(t.assignedName)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-ink">{p.dot} {t.title}</p>
                    {t.description ? <p className="mt-0.5 text-xs text-muted">{t.description}</p> : null}
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <Chip cls={everyone ? "bg-slate-100 text-slate-500" : "bg-violet-50 text-violet-700"}>{everyone ? L("👥 للكل", "👥 Everyone") : `👤 ${t.assignedName}`}</Chip>
                      {t.dueDate ? <Chip cls={od ? "bg-red-100 font-bold text-red-700" : "border border-slate-200 bg-white text-muted"}>⏰ {fmt(t.dueDate)}{od ? L(" · متأخّرة", " · overdue") : ""}</Chip> : null}
                      {t.status === "in_progress" ? <Chip cls="bg-amber-100 font-bold text-amber-700">⏳ {L("جاري", "In progress")}</Chip> : null}
                      {t.fromRoutine ? <Chip cls="bg-brand-light text-brand-dark">🔁 {L("روتين", "Routine")}</Chip> : null}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col items-end justify-center gap-1.5">
                    <button disabled={busy} onClick={() => setStatus(t, "done")} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50">{L("✓ تم", "✓ Done")}</button>
                    <button disabled={busy} onClick={() => remove(t)} className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50">{L("حذف", "Delete")}</button>
                  </div>
                </div>
                <TaskThread taskId={t.id} locale={locale} load={managerListComments} add={managerAddComment} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Tile({ label, value, color, danger }: { label: string; value: number; color: string; danger?: boolean }) {
  return (
    <div className={`rounded-2xl border p-3.5 ${danger ? "border-red-100 bg-red-50" : "border-slate-200 bg-white"}`}>
      <p className="text-xs text-muted">{label}</p>
      <p className={`mt-1 text-2xl font-extrabold ${color}`}>{value}</p>
    </div>
  );
}

function Chip({ children, cls }: { children: React.ReactNode; cls: string }) {
  return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] ${cls}`}>{children}</span>;
}
