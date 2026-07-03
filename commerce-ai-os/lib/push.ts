import "server-only";
import webpush from "web-push";
import type { PushPayload, StoredSubscription } from "./push-compute";

// Env-gated web-push sender. Ships INACTIVE: until the three VAPID variables
// exist (NEXT_PUBLIC_VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT),
// pushConfigured() is false and every caller degrades to a no-op — same
// pattern as the Shopify push and the Upstash limiter.
//
// Generate keys once with:  npx web-push generate-vapid-keys
// (the public key ships to the browser; the private key is server-only).

export function pushConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY &&
    process.env.VAPID_PRIVATE_KEY,
  );
}

function configure(): boolean {
  const pub = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) return false;
  const subject = process.env.VAPID_SUBJECT || "mailto:owner@example.com";
  webpush.setVapidDetails(subject, pub, priv);
  return true;
}

export interface SendResult {
  configured: boolean;
  sent: number;
  failed: number;
  pruned: string[]; // endpoints that are permanently gone (404/410) → delete
}

/**
 * Send one payload to a batch of stored subscriptions. Endpoints that come
 * back 404/410 are dead (the user revoked or the browser rotated them) and are
 * returned in `pruned` so the caller can delete their rows. Other errors count
 * as failed but keep the subscription (transient push-service hiccups).
 */
export async function sendPushToSubscriptions(
  subs: StoredSubscription[],
  payload: PushPayload,
): Promise<SendResult> {
  if (!configure()) return { configured: false, sent: 0, failed: 0, pruned: [] };

  const body = JSON.stringify(payload);
  let sent = 0, failed = 0;
  const pruned: string[] = [];

  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        body,
        { TTL: 12 * 60 * 60 }, // a morning alert is stale by evening
      );
      sent++;
    } catch (e: any) {
      const code = Number(e?.statusCode);
      if (code === 404 || code === 410) pruned.push(s.endpoint);
      else failed++;
    }
  }));

  return { configured: true, sent, failed, pruned };
}
