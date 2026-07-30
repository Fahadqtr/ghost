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

/**
 * Why the limiter returned what it did. Diagnostic only — every value is a
 * fixed enum literal, never carries request/response/secret data. "ok" means
 * Upstash answered (whether the attempt was allowed or blocked); all other
 * values mean the limiter FAILED OPEN and did not actually enforce.
 */
export type RateLimitReason =
  | "ok"
  | "missing_config"
  | "upstream_status"
  | "timeout"
  | "invalid_response"
  | "network_error";

export interface RateLimitResult {
  configured: boolean;   // false = no Upstash env, nothing enforced
  allowed: boolean;
  remaining: number;     // attempts left in this window (0 when blocked)
  retryAfterSec: number; // seconds until the window resets (0 when allowed)
  reason: RateLimitReason; // diagnostic classification (no sensitive data)
}

/**
 * Emit ONE warning line when the limiter fails open, carrying ONLY the scope
 * and the typed reason — never a URL, token, Redis key, IP, phone, name,
 * request/response body, or stack. Silent on "ok" (including real blocks).
 */
function logFailOpen(scope: string, reason: RateLimitReason): void {
  if (reason === "ok") return;
  console.warn(`[ratelimit] fail_open scope=${scope} reason=${reason}`);
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
    logFailOpen(scope, "missing_config");
    return { configured: false, allowed: true, remaining: limit, retryAfterSec: 0, reason: "missing_config" };
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
      reason: "ok", // Upstash answered — enforcement is live (allowed or blocked)
    };
  } catch (e) {
    // Fail OPEN, but classify WHY so a single safe log line can explain it.
    const reason = classifyRateLimitError(e);
    logFailOpen(scope, reason);
    return { configured: true, allowed: true, remaining: limit, retryAfterSec: 0, reason };
  }
}

/**
 * Map a thrown fetch/parse error to a typed reason — no message text, status
 * body, or stack is retained (only the enum literal leaves this function).
 */
function classifyRateLimitError(e: unknown): RateLimitReason {
  if (e instanceof Error) {
    // AbortSignal.timeout(...) rejects with a TimeoutError (AbortError on some runtimes).
    if (e.name === "TimeoutError" || e.name === "AbortError") return "timeout";
    if (e.message.startsWith("upstash ")) return "upstream_status"; // thrown on !res.ok
    if (e.message === "bad pipeline response") return "invalid_response";
  }
  return "network_error";
}
