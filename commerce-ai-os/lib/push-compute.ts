// Web-push content + subscription validation — pure, DB-free core.
//
// What goes INTO a push (composed from the same aggregated alerts the in-app
// bell shows) and what a browser PushSubscription must look like before we
// store it. No web-push / Supabase imports, so it is unit-testable; sending
// and storage live in lib/push.ts and the API routes.

/** Minimal alert shape shared with lib/notifications.ts items. */
export interface PushAlert {
  ar: string;
  severity: "high" | "med" | "low";
}

export interface PushPayload {
  title: string;
  body: string;
  url: string; // where a tap opens the app
}

/**
 * Compose the morning push from the aggregated alerts: high/med items only
 * (the bell's "low" items are noise on a lock screen), top 3, joined on one
 * line. Returns null when there is nothing worth waking the owner's phone for.
 */
export function composeMorningPush(alerts: PushAlert[]): PushPayload | null {
  const urgent = alerts.filter((a) => a.severity === "high" || a.severity === "med");
  if (!urgent.length) return null;
  const lines = urgent.slice(0, 3).map((a) => a.ar);
  const more = urgent.length - lines.length;
  return {
    title: "ملاك — تنبيهات الصباح",
    body: lines.join(" · ") + (more > 0 ? ` · +${more}` : ""),
    url: "/dashboard",
  };
}

/** A stored/storable push subscription (mirrors the browser's toJSON()). */
export interface StoredSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * Validate the JSON a browser posts for PushSubscription.toJSON():
 * { endpoint, keys: { p256dh, auth } }. Returns null when malformed —
 * never store a row we can't send to.
 */
export function parseSubscription(body: unknown): StoredSubscription | null {
  const b = body as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
  const endpoint = typeof b?.endpoint === "string" ? b.endpoint.trim() : "";
  const p256dh = typeof b?.keys?.p256dh === "string" ? b.keys.p256dh.trim() : "";
  const auth = typeof b?.keys?.auth === "string" ? b.keys.auth.trim() : "";
  if (!endpoint.startsWith("https://") || !p256dh || !auth) return null;
  return { endpoint, p256dh, auth };
}
