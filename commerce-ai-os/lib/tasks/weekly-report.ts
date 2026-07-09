// Weekly staff-task performance report — pure, DB-free compute (+tests).
//
// Attribution: a completed task counts for the member it was ASSIGNED to;
// "everyone" tasks (assigned_to null) count for whoever completed them
// (completed_by carries "staff:<name>"). Reopened tasks lose completed_at,
// so they naturally drop out of the done count.

export interface ReportTask {
  assigned_to: string | null;
  status: string | null;
  created_at: string | null;
  completed_at: string | null;
  completed_by: string | null;
  due_date: string | null;
}

export interface MemberWeekStats {
  id: string;
  name: string;
  done: number;      // completed inside the window
  late: number;      // of those, finished after their due date
  open: number;      // still open right now (assigned to them)
  overdue: number;   // of those, past due
  avgHours: number | null; // mean created→completed, 1 decimal
}

export interface WeeklyReport {
  from: string;
  to: string;
  totals: { done: number; created: number; open: number; overdue: number };
  members: MemberWeekStats[];
}

const t = (v: string | null): number | null => {
  if (!v) return null;
  const n = new Date(v).getTime();
  return Number.isNaN(n) ? null : n;
};

/** End of a due DATE = that day's 23:59:59 local — matching the UI's overdue rule. */
const dueEnd = (d: string | null): number | null => (d ? t(`${d}T23:59:59`) : null);

export function computeWeeklyReport(
  tasks: ReportTask[],
  members: { id: string; name: string }[],
  from: Date,
  to: Date,
): WeeklyReport {
  const f = from.getTime();
  const e = to.getTime();
  const byName = new Map(members.map((m) => [m.name.trim().toLowerCase(), m.id]));

  const stats = new Map<string, MemberWeekStats>(
    members.map((m) => [m.id, { id: m.id, name: m.name, done: 0, late: 0, open: 0, overdue: 0, avgHours: null }]),
  );
  const sumHours = new Map<string, { h: number; n: number }>();
  let totalDone = 0, totalCreated = 0, totalOpen = 0, totalOverdue = 0;

  for (const task of tasks) {
    const created = t(task.created_at);
    const completed = t(task.completed_at);
    if (created != null && created >= f && created < e) totalCreated++;

    // Who does this task belong to, for counting purposes?
    const byCompleter = String(task.completed_by ?? "").replace(/^staff:/, "").trim().toLowerCase();
    const owner = task.assigned_to ?? (byCompleter ? byName.get(byCompleter) ?? null : null);
    const s = owner ? stats.get(owner) : undefined;

    if (completed != null && completed >= f && completed < e && String(task.status) === "done") {
      totalDone++;
      if (s) {
        s.done++;
        const due = dueEnd(task.due_date);
        if (due != null && completed > due) s.late++;
        if (created != null && completed >= created) {
          const acc = sumHours.get(owner!) ?? { h: 0, n: 0 };
          acc.h += (completed - created) / 3_600_000;
          acc.n++;
          sumHours.set(owner!, acc);
        }
      }
    }

    if (String(task.status) !== "done") {
      totalOpen++;
      const due = dueEnd(task.due_date);
      const isOverdue = due != null && due < e;
      if (isOverdue) totalOverdue++;
      if (task.assigned_to) {
        const so = stats.get(task.assigned_to);
        if (so) { so.open++; if (isOverdue) so.overdue++; }
      }
    }
  }

  for (const [id, acc] of sumHours) {
    const s = stats.get(id);
    if (s && acc.n > 0) s.avgHours = Math.round((acc.h / acc.n) * 10) / 10;
  }

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    totals: { done: totalDone, created: totalCreated, open: totalOpen, overdue: totalOverdue },
    members: [...stats.values()].sort((a, b) => b.done - a.done || a.name.localeCompare(b.name)),
  };
}
