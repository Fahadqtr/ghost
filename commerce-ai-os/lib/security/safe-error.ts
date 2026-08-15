// CH.3 — safe error surface for externally reachable server actions / routes.
//
// Externally reachable code (server actions are independently invokable POST
// endpoints; route handlers are public URLs) must NEVER return a raw DB / driver
// error to the caller — those messages leak schema, column names, RLS policy
// hints, and internal wiring. This module keeps FULL detail in the server logs
// (observability preserved) while returning ONLY a fixed, safe public string.
//
// PURE: no imports, no framework, no DB. node:test loads it directly. The only
// side effect is console.error (server log), which is intentional and swallowed
// if the environment has no console.

/** Best-effort human string for any thrown value — for INTERNAL logging only. */
export function describeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  if (e && typeof e === "object") {
    const o = e as { message?: unknown; code?: unknown };
    const parts = [o.code, o.message].filter((v) => typeof v === "string" && v);
    if (parts.length) return parts.join(" ");
    try { return JSON.stringify(e); } catch { return String(e); }
  }
  return String(e);
}

/**
 * Log the raw detail server-side under a stable tag and return the fixed public
 * message. The public message is ALL the caller ever sees; the raw error stays
 * in the logs. Use at every `catch`/`if (error)` boundary of an externally
 * reachable action instead of returning `error.message` / `e.message`.
 */
export function safeError(tag: string, detail: unknown, publicMessage: string): string {
  try {
    // eslint-disable-next-line no-console
    console.error(`[${tag}] ${describeError(detail)}`);
  } catch {
    /* no console in this environment — the public message is still returned */
  }
  return publicMessage;
}
