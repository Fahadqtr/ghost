// Pure engagement math for the Instagram performance report — DB/API-free,
// shared by the server action and the /social client.

export interface PostStats {
  likes: number;
  comments: number;
  reach: number;
  views: number;
  saved: number;
  shares: number;
}

export const EMPTY_STATS: PostStats = { likes: 0, comments: 0, reach: 0, views: 0, saved: 0, shares: 0 };

/** Weighted engagement: a save/share signals intent much harder than a like. */
export function engagementScore(s: PostStats): number {
  return s.likes + s.comments * 2 + s.saved * 3 + s.shares * 3;
}

/** Engagement ÷ reach (null when reach is unknown — old media, token limits). */
export function engagementRate(s: PostStats): number | null {
  if (!(s.reach > 0)) return null;
  return (s.likes + s.comments + s.saved + s.shares) / s.reach;
}

export function ratePct(rate: number | null): string {
  return rate == null ? "—" : `${(rate * 100).toFixed(1)}%`;
}

export interface InsightRowLite {
  id: string;
  stats: PostStats;
}

/** Totals + the strongest post across the report window. */
export function summarizeInsights<T extends InsightRowLite>(rows: T[]): {
  totals: PostStats;
  bestId: string | null;
  avgReach: number;
} {
  const totals: PostStats = { ...EMPTY_STATS };
  let bestId: string | null = null;
  let bestScore = -1;
  for (const r of rows) {
    totals.likes += r.stats.likes;
    totals.comments += r.stats.comments;
    totals.reach += r.stats.reach;
    totals.views += r.stats.views;
    totals.saved += r.stats.saved;
    totals.shares += r.stats.shares;
    const sc = engagementScore(r.stats);
    if (sc > bestScore) { bestScore = sc; bestId = r.id; }
  }
  return { totals, bestId, avgReach: rows.length ? Math.round(totals.reach / rows.length) : 0 };
}
