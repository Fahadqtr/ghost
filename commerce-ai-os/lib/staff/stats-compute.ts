// Staff movement aggregation — pure, DB-free core.
//
// Given this-week's staff stock movements (already fetched), roll them up into
// today/week IN-OUT counts, review-state tallies, and a per-employee breakdown
// for today. The day boundary is passed in (epoch ms) so the function stays
// deterministic and testable; the fetch + the separate product/task counts live
// in stats.ts.

export interface StaffMovementRow {
  created_at?: string | null;
  action_type?: string | null;
  agent?: string | null;
  details?: {
    quantity?: unknown;
    by?: unknown;
    review?: unknown;
  } | null;
}

export interface StaffMovementAgg {
  today: { in: number; out: number; inUnits: number; outUnits: number };
  week: { in: number; out: number };
  review: { pending: number; approved: number; reversed: number };
  byEmployeeToday: { name: string; in: number; out: number }[];
}

/**
 * Aggregate staff movements. `rows` are assumed already scoped to the week
 * (that's the DB query's job); `todayStartMs` is the epoch-ms start of today, so
 * rows at/after it also count toward today's totals and the per-employee split.
 */
export function aggregateStaffMovements(rows: StaffMovementRow[], todayStartMs: number): StaffMovementAgg {
  const agg: StaffMovementAgg = {
    today: { in: 0, out: 0, inUnits: 0, outUnits: 0 },
    week: { in: 0, out: 0 },
    review: { pending: 0, approved: 0, reversed: 0 },
    byEmployeeToday: [],
  };
  const byEmp = new Map<string, { in: number; out: number }>();

  for (const r of rows) {
    const isIn = r.action_type === "stock_in";
    const qty = Number(r.details?.quantity ?? 0);
    const atMs = new Date(r.created_at ?? 0).getTime();
    const name = String(r.details?.by ?? r.agent ?? "").replace(/^staff:/, "") || "—";

    if (isIn) agg.week.in++; else agg.week.out++;

    const rev = r.details?.review;
    if (rev === "approved") agg.review.approved++;
    else if (rev === "reversed") agg.review.reversed++;
    else agg.review.pending++;

    if (atMs >= todayStartMs) {
      if (isIn) { agg.today.in++; agg.today.inUnits += qty; } else { agg.today.out++; agg.today.outUnits += qty; }
      const e = byEmp.get(name) ?? { in: 0, out: 0 };
      if (isIn) e.in++; else e.out++;
      byEmp.set(name, e);
    }
  }

  agg.byEmployeeToday = Array.from(byEmp.entries())
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => b.in + b.out - (a.in + a.out))
    .slice(0, 6);

  return agg;
}
