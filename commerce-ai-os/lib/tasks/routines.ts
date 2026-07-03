import "server-only";
import { dueRoutines, planRoutineTasks, type RoutineRow } from "./routines-compute";

// Lazily materialize today's tasks from active routines. Called whenever tasks
// are listed (manager or staff) — cheap, idempotent, and serverless-friendly:
// the partial unique index (routine_id, routine_date) makes double-inserts
// no-ops, so concurrent callers can't duplicate an instance. The due-filter and
// row-planning logic is pure and unit-tested in routines-compute.ts.

export { mapRoutine } from "./routines-compute";
export type { Routine } from "./routines-compute";

export async function materializeRoutines(admin: any): Promise<void> {
  try {
    const { data, error } = await admin.from("task_routines").select("*").eq("active", true);
    if (error || !data?.length) return; // table missing or nothing to do

    const now = new Date();
    const todayISO = now.toISOString().slice(0, 10);
    const weekday = now.getUTCDay(); // matches the stored 0=Sunday convention

    const due = dueRoutines(data as RoutineRow[], weekday);
    if (!due.length) return;

    // Which are already materialized today?
    const ids = due.map((r) => r.id);
    const { data: existing } = await admin
      .from("staff_tasks")
      .select("routine_id")
      .in("routine_id", ids)
      .eq("routine_date", todayISO);

    const rows = planRoutineTasks(due, (existing ?? []).map((x: any) => String(x.routine_id)), todayISO);
    if (!rows.length) return;

    // The unique index absorbs races: a concurrent duplicate insert fails that
    // row only; upsert+ignoreDuplicates keeps the rest.
    await admin.from("staff_tasks").upsert(rows, { onConflict: "routine_id,routine_date", ignoreDuplicates: true });
  } catch {
    /* best-effort — never block task listing */
  }
}
