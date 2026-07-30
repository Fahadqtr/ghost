// Pure, dependency-injected core for the scheduled-social publisher. It owns
// the "which approved posts are due, in what order, how many, and claim each
// before the external call" logic — with NO I/O and no `server-only`/`@/`
// imports, so node:test can exercise every branch (due filter, ordering, limit,
// claim-before-publish, concurrency, success/failure) with mocks. The cron route
// wires the real Supabase + Instagram capabilities as `deps`.
//
// Time is compared in UTC via epoch milliseconds (Date#getTime), never via
// string compare or the server's local timezone — a scheduled_at at/onbefore
// `nowIso` is due regardless of how the timestamp is formatted.

/** A row from social_posts, as far as scheduling cares. */
export interface SchedulablePost {
  id: string;
  platform: string;
  caption: string;
  image_url: string;
  status: string;
  approved?: boolean | null;
  scheduled_at?: string | null;
  extras?: { kind?: string; storyKind?: string } | null;
}

/**
 * Max posts a single run may publish. Small and bounded so one tick can never
 * fan out unboundedly or let a hung external call starve the rest — the next
 * 15-minute run picks up the remainder, oldest first.
 */
export const PUBLISH_LIMIT = 3;

/** Safe, generic failure text stored on the row + shown in the UI. Never a raw
 *  Meta/TikTok error (those can carry request detail); the real reason is logged
 *  server-side as a classified category only. */
export const SAFE_PUBLISH_FAILURE_MESSAGE = "تعذّر النشر تلقائيًا — أعِد المحاولة من صفحة السوشيال.";

/** Coarse, non-sensitive failure buckets for server logs. Derived from the raw
 *  error text but the raw text itself is NEVER logged or stored. */
export type PublishFailureCategory = "auth" | "rate_limit" | "timeout" | "media" | "unknown";

/** Classify a raw publish error into a safe category (keyword match only). The
 *  input is inspected here and discarded; only the returned enum escapes. */
export function classifyPublishFailure(raw: string | null | undefined): PublishFailureCategory {
  const s = String(raw ?? "").toLowerCase();
  if (!s) return "unknown";
  if (/\b(401|403|token|oauth|permission|scope|unauthor)/.test(s)) return "auth";
  if (/\b(429|rate limit|too many|throttl)/.test(s)) return "rate_limit";
  if (/timeout|timed out|abort|etimedout/.test(s)) return "timeout";
  if (/media|image|video|url|format|unsupported|download/.test(s)) return "media";
  return "unknown";
}

/** Emit ONE safe log line for a failure — scope + platform + kind + category
 *  only. Never a token, Authorization header, signed media URL, or raw error. */
export function logPublishFailure(
  warn: (line: string) => void,
  info: { platform: string; kind: string; category: PublishFailureCategory },
): void {
  warn(`[publish-social] fail platform=${info.platform} kind=${info.kind} reason=${info.category}`);
}

/** Is this row due to publish now? Approved, still pending, and its UTC
 *  scheduled time is at/onbefore `nowIso`. Epoch compare — timezone-safe. */
export function isDue(p: SchedulablePost, nowIso: string): boolean {
  if (p.status !== "pending") return false;      // never re-touch posted/publishing/failed/dismissed
  if (p.approved !== true) return false;          // owner approval is mandatory
  if (!p.scheduled_at) return false;
  const at = new Date(p.scheduled_at).getTime();
  const now = new Date(nowIso).getTime();
  if (!Number.isFinite(at) || !Number.isFinite(now)) return false;
  return at <= now;
}

/** The exact ordered, capped set a single run may publish: due only, oldest
 *  scheduled first, capped at `limit`. */
export function selectDuePosts(rows: SchedulablePost[], nowIso: string, limit: number = PUBLISH_LIMIT): SchedulablePost[] {
  const cap = Math.max(0, limit);
  return rows
    .filter((p) => isDue(p, nowIso))
    .sort((a, b) => new Date(a.scheduled_at as string).getTime() - new Date(b.scheduled_at as string).getTime())
    .slice(0, cap);
}

export interface PublishDueDeps {
  nowIso: string;
  limit?: number;
  /** Fetch candidate rows (the route filters/orders/limits in SQL; the core
   *  re-applies selectDuePosts as the authoritative gate). */
  fetchCandidates: (nowIso: string, limit: number) => Promise<SchedulablePost[]>;
  /** Atomically move pending → publishing for this id. Resolves true only if
   *  THIS call won the row (compare-and-set on status = 'pending'); false means
   *  another run/retry already claimed it. Must happen BEFORE any external call. */
  claim: (id: string) => Promise<boolean>;
  /** Perform the external publish. Returns ok + media id (+ whether a feed post
   *  was mirrored to a story); on failure returns the raw error for the core to
   *  CLASSIFY (never store/emit) — nothing else. */
  publish: (post: SchedulablePost) => Promise<{ ok: boolean; mediaId?: string | null; storyMirrored?: boolean; rawError?: string | null }>;
  markPosted: (id: string, mediaId: string | null, storyMirrored: boolean) => Promise<void>;
  markFailed: (id: string, safeMessage: string) => Promise<void>;
  warn?: (line: string) => void;
}

export interface PublishOutcome {
  id: string;
  status: "posted" | "failed" | "skipped" | "not_claimed";
  platform?: string;
  kind?: string;
}

/**
 * Publish every due post, oldest first, up to the limit — claiming each row
 * before its external call so overlapping cron runs, Vercel retries, and a
 * concurrent manual publish can never post the same row twice. A published row
 * is never eligible (isDue requires pending), and a failure flips the row to
 * `failed` with a generic message (owner retries from /social).
 */
export async function publishDuePosts(deps: PublishDueDeps): Promise<{ published: number; results: PublishOutcome[] }> {
  const limit = deps.limit ?? PUBLISH_LIMIT;
  const candidates = await deps.fetchCandidates(deps.nowIso, limit);
  const due = selectDuePosts(candidates, deps.nowIso, limit);

  const results: PublishOutcome[] = [];
  for (const post of due) {
    const kind = post.extras?.kind ?? "post";
    // Only Instagram is auto-published today; other platforms are left pending
    // (never claimed, so they can't get stuck) for a future channel.
    if (post.platform !== "instagram") {
      results.push({ id: post.id, status: "skipped", platform: post.platform, kind });
      continue;
    }
    // CLAIM before any external call — the one and only concurrency guard.
    const claimed = await deps.claim(post.id);
    if (!claimed) {
      results.push({ id: post.id, status: "not_claimed", platform: post.platform, kind });
      continue;
    }
    const res = await deps.publish(post);
    if (res.ok) {
      await deps.markPosted(post.id, res.mediaId ?? null, !!res.storyMirrored);
      results.push({ id: post.id, status: "posted", platform: post.platform, kind });
    } else {
      const category = classifyPublishFailure(res.rawError);
      logPublishFailure(deps.warn ?? (() => {}), { platform: post.platform, kind, category });
      await deps.markFailed(post.id, SAFE_PUBLISH_FAILURE_MESSAGE);
      results.push({ id: post.id, status: "failed", platform: post.platform, kind });
    }
  }
  return { published: results.filter((r) => r.status === "posted").length, results };
}
