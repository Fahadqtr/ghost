// Morning alert push (Vercel Cron, 05:00 UTC = 08:00 Qatar). Composes ONE
// short notification from the same aggregated alerts the in-app bell shows
// (high/med only) and sends it to every stored web-push subscription. Nothing
// urgent → sends nothing. Dead endpoints (404/410) are pruned.
//
// Auth: same CRON_SECRET bearer scheme as availability-sync. The /api/cron
// prefix is already public in the proxy middleware; this route authenticates
// itself. Env-gated twice over: no VAPID keys → no-op; no subscriptions → no-op.
import { createAdminClient } from "@/lib/supabase/admin";
import { getNotifications } from "@/lib/notifications";
import { composeMorningPush } from "@/lib/push-compute";
import { pushConfigured, sendPushToSubscriptions } from "@/lib/push";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (!pushConfigured()) {
    return Response.json({ ok: true, configured: false, note: "VAPID keys not set — nothing sent" });
  }

  let admin;
  try { admin = createAdminClient(); }
  catch (e: any) { return Response.json({ ok: false, error: e?.message ?? "service role unavailable" }, { status: 500 }); }

  try {
    const { data: subs, error } = await admin
      .from("push_subscriptions")
      .select("endpoint, p256dh, auth")
      .limit(500);
    if (error) {
      const hint = /push_subscriptions/.test(error.message)
        ? " — run supabase/push_subscriptions.sql once in the SQL editor"
        : "";
      return Response.json({ ok: false, error: error.message + hint }, { status: 500 });
    }
    if (!subs?.length) return Response.json({ ok: true, configured: true, subscriptions: 0, sent: 0 });

    const { items } = await getNotifications();
    const payload = composeMorningPush(items);
    if (!payload) return Response.json({ ok: true, configured: true, subscriptions: subs.length, sent: 0, allClear: true });

    const res = await sendPushToSubscriptions(subs, payload);
    if (res.pruned.length) {
      await admin.from("push_subscriptions").delete().in("endpoint", res.pruned);
    }
    return Response.json({
      ok: true,
      configured: true,
      subscriptions: subs.length,
      sent: res.sent,
      failed: res.failed,
      pruned: res.pruned.length,
      body: payload.body,
    });
  } catch (e: any) {
    return Response.json({ ok: false, error: e?.message ?? "notify failed" }, { status: 500 });
  }
}
