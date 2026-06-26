// Best-effort in-memory rate limiter (F3). Per server instance — on serverless
// this is per-warm-lambda, not global, but it still blunts a single session
// looping a paid endpoint (Anthropic/OpenAI/ElevenLabs) and runaway loops. For
// strict global limits, swap the Map for Upstash/Vercel KV later.
const buckets = new Map<string, number[]>();

// Returns ok=false (with retry hint) once `max` hits occur within `windowMs`.
export function rateLimit(key: string, max: number, windowMs: number): { ok: boolean; retryMs: number } {
  const now = Date.now();
  const arr = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (arr.length >= max) {
    const retryMs = Math.max(0, windowMs - (now - arr[0]));
    buckets.set(key, arr);
    return { ok: false, retryMs };
  }
  arr.push(now);
  buckets.set(key, arr);
  // Opportunistic cleanup so the Map can't grow unbounded.
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) if (!v.some((t) => now - t < windowMs)) buckets.delete(k);
  }
  return { ok: true, retryMs: 0 };
}

// Single-use token guard (F7): remember consumed token signatures for `ttlMs`
// so a captured confirm token can't be replayed (best-effort, per instance).
const consumed = new Map<string, number>();
export function consumeOnce(sig: string, ttlMs: number): boolean {
  const now = Date.now();
  const prev = consumed.get(sig);
  if (prev && now - prev < ttlMs) return false; // already used
  consumed.set(sig, now);
  if (consumed.size > 10000) {
    for (const [k, t] of consumed) if (now - t >= ttlMs) consumed.delete(k);
  }
  return true;
}
