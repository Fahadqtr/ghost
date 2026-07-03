import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { aggregateStaffMovements, type StaffMovementRow } from "./stats-compute";

// Staff stock-movement stats for the manager dashboard: today's IN/OUT, this
// week's IN/OUT, the approval indicators, and a per-employee breakdown (today).

export type StaffStats = {
  configured: boolean;
  today: { in: number; out: number; inUnits: number; outUnits: number };
  week: { in: number; out: number };
  review: { pending: number; approved: number; reversed: number };
  byEmployeeToday: { name: string; in: number; out: number }[];
  pendingProducts: number; // new products submitted by staff, awaiting approval
  tasks: { open: number; overdue: number };
};

const EMPTY: StaffStats = {
  configured: false,
  today: { in: 0, out: 0, inUnits: 0, outUnits: 0 },
  week: { in: 0, out: 0 },
  review: { pending: 0, approved: 0, reversed: 0 },
  byEmployeeToday: [],
  pendingProducts: 0,
  tasks: { open: 0, overdue: 0 },
};

export async function getStaffStats(): Promise<StaffStats> {
  let admin: any;
  try {
    admin = createAdminClient();
  } catch {
    return EMPTY;
  }

  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  weekAgo.setHours(0, 0, 0, 0);
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const { data, error } = await admin
    .from("malak_audit")
    .select("created_at, action_type, agent, details")
    .like("agent", "staff:%")
    .in("action_type", ["stock_in", "stock_out"])
    .gte("created_at", weekAgo.toISOString())
    .order("created_at", { ascending: false })
    .limit(3000);
  if (error) return EMPTY;

  // Staff-submitted products awaiting approval (approval null + origin tag).
  let pendingProducts = 0;
  try {
    const { count } = await admin
      .from("products")
      .select("id", { count: "exact", head: true })
      .is("approval", null)
      .like("notes", "staff-new:%");
    pendingProducts = count ?? 0;
  } catch { /* best-effort */ }

  // Open / overdue employee tasks.
  let tasksOpen = 0, tasksOverdue = 0;
  try {
    const { count: openCount } = await admin
      .from("staff_tasks").select("id", { count: "exact", head: true }).neq("status", "done");
    tasksOpen = openCount ?? 0;
    const todayISO = new Date().toISOString().slice(0, 10);
    const { count: odCount } = await admin
      .from("staff_tasks").select("id", { count: "exact", head: true }).neq("status", "done").lt("due_date", todayISO);
    tasksOverdue = odCount ?? 0;
  } catch { /* table may not exist yet */ }

  const agg = aggregateStaffMovements((data ?? []) as StaffMovementRow[], todayStart.getTime());

  return {
    configured: true,
    ...agg,
    pendingProducts,
    tasks: { open: tasksOpen, overdue: tasksOverdue },
  };
}
