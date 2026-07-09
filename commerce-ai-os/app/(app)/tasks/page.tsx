import { listTasks, listRoutines } from "./actions";
import { listStaff } from "../team/actions";
import TasksClient from "./TasksClient";
import WeeklyTaskReport from "@/components/WeeklyTaskReport";
import { getT } from "@/lib/i18n-server";

export const dynamic = "force-dynamic";

export default async function TasksPage() {
  const { locale } = await getT();
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);

  let tasks: Awaited<ReturnType<typeof listTasks>>["tasks"] = [];
  let ready = true;
  let error: string | undefined;
  try {
    ({ tasks, ready, error } = await listTasks());
  } catch (e: any) {
    error = e?.message || L("تعذّر تحميل المهام.", "Couldn't load tasks.");
  }
  const staff = (await listStaff().catch(() => ({ members: [] }))).members.map((m) => ({ id: m.id, name: m.name }));
  const routinesRes = await listRoutines().catch(() => ({ routines: [], ready: true as boolean }));

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold text-ink">{L("مهام الموظفين", "Staff tasks")}</h2>
        <p className="text-sm text-muted">{L("كلّف موظفيك بمهام وتابِع إنجازها. تظهر لهم في صفحة", "Assign tasks and track completion. They appear on the employee page")} <code className="rounded-sm bg-slate-100 px-1">/staff</code>.</p>
      </div>

      {!ready ? (
        <div className="card space-y-2 border-amber-200 bg-amber-50 text-sm text-amber-800">
          <div className="font-medium">{L("إعداد لمرة واحدة", "One-time setup")}</div>
          <p>{L("شغّل", "Run")} <code className="rounded-sm bg-white px-1">supabase/staff_tasks.sql</code> {L("مرة وحدة في Supabase، ثم حدّث الصفحة.", "once in Supabase, then refresh.")}</p>
        </div>
      ) : error ? (
        <div className="card border-amber-200 bg-amber-50 text-sm text-amber-800">{error}</div>
      ) : (
        <>
          <WeeklyTaskReport locale={locale} />
          <TasksClient initialTasks={tasks} staff={staff} locale={locale} initialRoutines={routinesRes.routines} routinesReady={routinesRes.ready} />
        </>
      )}
    </div>
  );
}
