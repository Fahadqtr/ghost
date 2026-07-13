// Per-format Reels metrics — pure, DB-free (unit-tested).
//
// Powers the Sunday review rule: a format that averages < 50% of the weekly
// MEDIAN views for 2 consecutive weeks gets cut to 1/week, its slots reallocated
// to the top format. This computes the weekly per-format averages and the cut
// list from raw (format, week, views) rows.

export interface ReelMetricRow {
  format: string;
  week: string; // any sortable week key, e.g. "2026-W28"
  views: number;
}

export interface FormatWeekAvg {
  week: string;
  format: string;
  count: number;
  avgViews: number;
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Average views per (week, format). */
export function formatWeeklyAverages(rows: ReelMetricRow[]): FormatWeekAvg[] {
  const agg = new Map<string, { week: string; format: string; total: number; count: number }>();
  for (const r of rows) {
    if (!r.format) continue;
    const views = Number.isFinite(r.views) ? r.views : 0;
    const key = `${r.week}||${r.format}`;
    const cur = agg.get(key) ?? { week: r.week, format: r.format, total: 0, count: 0 };
    cur.total += views;
    cur.count += 1;
    agg.set(key, cur);
  }
  return [...agg.values()].map((a) => ({
    week: a.week, format: a.format, count: a.count,
    avgViews: a.count ? Math.round((a.total / a.count) * 100) / 100 : 0,
  }));
}

/** Distinct weeks, oldest → newest. */
export function sortedWeeks(rows: ReelMetricRow[]): string[] {
  return [...new Set(rows.map((r) => r.week))].sort();
}

/**
 * Formats to cut: those whose weekly average is BELOW `threshold` × the week's
 * median (across formats) for the last `consecutive` weeks in a row. Needs at
 * least `consecutive` weeks of data; otherwise returns [] (not enough signal).
 */
export function formatsToCut(
  rows: ReelMetricRow[],
  opts: { threshold?: number; consecutive?: number } = {},
): string[] {
  const threshold = opts.threshold ?? 0.5;
  const consecutive = opts.consecutive ?? 2;
  const weeks = sortedWeeks(rows);
  if (weeks.length < consecutive) return [];
  const recent = weeks.slice(-consecutive);

  const avgs = formatWeeklyAverages(rows);
  // week -> (format -> avg)
  const byWeek = new Map<string, Map<string, number>>();
  for (const a of avgs) {
    if (!byWeek.has(a.week)) byWeek.set(a.week, new Map());
    byWeek.get(a.week)!.set(a.format, a.avgViews);
  }
  // week -> median of that week's format averages
  const medianByWeek = new Map<string, number>();
  for (const w of recent) medianByWeek.set(w, median([...(byWeek.get(w)?.values() ?? [])]));

  const allFormats = [...new Set(avgs.map((a) => a.format))];
  return allFormats.filter((fmt) =>
    recent.every((w) => {
      const avg = byWeek.get(w)?.get(fmt);
      const med = medianByWeek.get(w) ?? 0;
      // Must have data that week AND be under the threshold band.
      return avg != null && med > 0 && avg < threshold * med;
    }),
  );
}
