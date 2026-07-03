// Routine → task materialization logic — pure, DB-free core.
//
// Which routines are due today, and which staff_tasks rows to insert for them
// (skipping ones already materialized). Kept free of server-only/Supabase so it
// is unit-testable; the fetch + upsert live in routines.ts.

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

/** Normalize a raw task_routines row into the UI shape (defensive defaults). */
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

/** Raw task_routines row (subset the materializer reads). */
export interface RoutineRow {
  id: string | number;
  title?: string | null;
  description?: string | null;
  assigned_to?: string | null;
  assigned_name?: string | null;
  priority?: string | null;
  frequency?: string | null;
  weekday?: number | string | null;
  created_by?: string | null;
}

/** A staff_tasks insert produced by materialization. */
export interface RoutineTaskInsert {
  title: string | null | undefined;
  description: string | null;
  assigned_to: string | null;
  assigned_name: string | null;
  priority: string;
  due_date: string;
  status: "open";
  created_by: string;
  routine_id: string | number;
  routine_date: string;
}

/** Routines due on the given weekday: weekly must match, daily always runs. */
export function dueRoutines(rows: RoutineRow[], weekday: number): RoutineRow[] {
  return rows.filter((r) => (r.frequency === "weekly" ? Number(r.weekday) === weekday : true));
}

/**
 * Build the staff_tasks inserts for today's due routines, excluding routines
 * already materialized today (`existingRoutineIds`, matched as strings).
 */
export function planRoutineTasks(
  due: RoutineRow[],
  existingRoutineIds: Iterable<string>,
  todayISO: string,
): RoutineTaskInsert[] {
  const done = new Set(existingRoutineIds);
  return due
    .filter((r) => !done.has(String(r.id)))
    .map((r) => ({
      title: r.title,
      description: r.description ?? null,
      assigned_to: r.assigned_to ?? null,
      assigned_name: r.assigned_name ?? null,
      priority: ["low", "normal", "high"].includes(r.priority as string) ? (r.priority as string) : "normal",
      due_date: todayISO,
      status: "open" as const,
      created_by: r.created_by ?? "routine",
      routine_id: r.id,
      routine_date: todayISO,
    }));
}
