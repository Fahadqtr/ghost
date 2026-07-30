// Env-gated fixed-window rate limiter backed by Upstash Redis (REST API).
//
// No SDK dependency — Upstash's REST API is plain HTTPS, so one fetch per
// check. Ships INACTIVE: until UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
// are set, every check allows (configured:false) and nothing changes in
// behavior. Serverless-safe: the counter lives in Redis, not process memory,
// so concurrent lambdas share one window.
//
// FAIL-OPEN by design: if Redis errors or times out we allow the request —
// this protects login availability (staff must never be locked out of the
// stock page by a Redis outage); the limiter is a brute-force brake, not an
// auth boundary. The window key/decision math is pure and unit-tested.

export interface RateLimitResult {
  configured: boolean;   // false = no Upstash env, nothing enforced
  allowed: boolean;
  remaining: number;     // attempts left in this window (0 when blocked)
  retryAfterSec: number; // seconds until the window resets (0 when allowed)
}

/** Fixed-window bucket key: same (scope,id) share a key within each window. */
export function windowKey(scope: string, id: string, nowMs: number, windowSec: number): string {
  const bucket = Math.floor(nowMs / (windowSec * 1000));
  return `rl:${scope}:${id}:${bucket}`;
}

/** Seconds until the current fixed window rolls over (min 1). */
export function secsUntilWindowEnd(nowMs: number, windowSec: number): number {
  const winMs = windowSec * 1000;
  return Math.max(1, Math.ceil((winMs - (nowMs % winMs)) / 1000));
}

/** Allow/deny from the post-increment count (count 1 = first attempt). */
export function decide(count: number, limit: number): { allowed: boolean; remaining: number } {
  return { allowed: count <= limit, remaining: Math.max(0, limit - count) };
}

/**
 * Best-effort client identity for rate limiting behind Vercel's proxy:
 * first hop of x-forwarded-for, else x-real-ip, else a shared bucket.
 * (Headers are spoofable in general; on Vercel the platform sets them.)
 */
export function clientIpFrom(xForwardedFor: string | null, xRealIp: string | null): string {
  const first = String(xForwardedFor ?? "").split(",")[0].trim();
  if (first) return first;
  const real = String(xRealIp ?? "").trim();
  if (real) return real;
  return "unknown";
}

/**
 * Gate a side-effecting operation behind a rate-limit check: run `perform`
 * only when the check allows it, otherwise `onLimited`. A fail-open result
 * (`configured:false`, or `allowed:true`) runs `perform`. This guarantees no
 * service-role DB/Storage/WhatsApp work starts before the limiter passes —
 * the check runs first and `perform` is never invoked on a block.
 */
export async function runIfAllowed<T>(
  check: () => Promise<RateLimitResult>,
  onLimited: () => T | Promise<T>,
  perform: () => Promise<T>,
): Promise<T> {
  const result = await check();
  if (result.configured && !result.allowed) return onLimited();
  return perform();
}

/**
 * Count one attempt for (scope,id) and decide. INCR + EXPIRE NX run in one
 * pipeline call, so the window TTL is set exactly once per bucket.
 */
export async function rateLimit(
  scope: string,
  id: string,
  opts?: { limit?: number; windowSec?: number },
): Promise<RateLimitResult> {
  const limit = opts?.limit ?? 10;
  const windowSec = opts?.windowSec ?? 300;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    return { configured: false, allowed: true, remaining: limit, retryAfterSec: 0 };
  }

  const now = Date.now();
  const key = windowKey(scope, id, now, windowSec);
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify([["INCR", key], ["EXPIRE", key, String(windowSec), "NX"]]),
      cache: "no-store",
      signal: AbortSignal.timeout(2000), // a slow limiter must not stall logins
    });
    if (!res.ok) throw new Error(`upstash ${res.status}`);
    const data = (await res.json()) as { result?: unknown }[];
    const count = Number(data?.[0]?.result);
    if (!Number.isFinite(count)) throw new Error("bad pipeline response");
    const { allowed, remaining } = decide(count, limit);
    return {
      configured: true,
      allowed,
      remaining,
      retryAfterSec: allowed ? 0 : secsUntilWindowEnd(now, windowSec),
    };
  } catch {
    return { configured: true, allowed: true, remaining: limit, retryAfterSec: 0 }; // fail open
  }
}
