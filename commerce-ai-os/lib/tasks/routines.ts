import "server-only";

// Lazily materialize today's tasks from active routines. Called whenever tasks
// are listed (manager or staff) — cheap, idempotent, and serverless-friendly:
// the partial unique index (routine_id, routine_date) makes double-inserts
// no-ops, so concurrent callers can't duplicate an instance.

export type Routine = {
  id: string;
  title: string;
  description: string | null;
  assignedTo: string | null;
  assignedName: string | null;
  priority: "low" | "normal" | "high";
  frequency: "daily" | "weekly";
  weekday: number | null; // 0=Sunday … 6=Saturday
  active: boolean;
  createdAt: string | null;
};

export function mapRoutine(r: any): Routine {
  return {
    id: String(r.id),
    title: r.title ?? "",
    description: r.description ?? null,
    assignedTo: r.assigned_to ?? null,
    assignedName: r.assigned_name ?? null,
    priority: (["low", "normal", "high"].includes(r.priority) ? r.priority : "normal"),
    frequency: r.frequency === "weekly" ? "weekly" : "daily",
    weekday: r.weekday == null ? null : Number(r.weekday),
    active: r.active !== false,
    createdAt: r.created_at ?? null,
  };
}

export async function materializeRoutines(admin: any): Promise<void> {
  try {
    const { data, error } = await admin.from("task_routines").select("*").eq("active", true);
    if (error || !data?.length) return; // table missing or nothing to do

    const now = new Date();
    const todayISO = now.toISOString().slice(0, 10);
    const weekday = now.getUTCDay(); // matches the stored 0=Sunday convention

    const due = (data as any[]).filter((r) =>
      r.frequency === "weekly" ? Number(r.weekday) === weekday : true
    );
    if (!due.length) return;

    // Which are already materialized today?
    const ids = due.map((r) => r.id);
    const { data: existing } = await admin
      .from("staff_tasks")
      .select("routine_id")
      .in("routine_id", ids)
      .eq("routine_date", todayISO);
    const done = new Set((existing ?? []).map((x: any) => String(x.routine_id)));

    const rows = due
      .filter((r) => !done.has(String(r.id)))
      .map((r) => ({
        title: r.title,
        description: r.description ?? null,
        assigned_to: r.assigned_to ?? null,
        assigned_name: r.assigned_name ?? null,
        priority: ["low", "normal", "high"].includes(r.priority) ? r.priority : "normal",
        due_date: todayISO,
        status: "open",
        created_by: r.created_by ?? "routine",
        routine_id: r.id,
        routine_date: todayISO,
      }));
    if (!rows.length) return;

    // The unique index absorbs races: a concurrent duplicate insert fails that
    // row only; upsert+ignoreDuplicates keeps the rest.
    await admin.from("staff_tasks").upsert(rows, { onConflict: "routine_id,routine_date", ignoreDuplicates: true });
  } catch {
    /* best-effort — never block task listing */
  }
}
