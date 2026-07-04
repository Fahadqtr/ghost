// Morning alert (Vercel Cron, 05:00 UTC = 08:00 Qatar). Composes ONE short
// summary from the same aggregated alerts the in-app bell shows (high/med
// only) and fans it out to every configured channel:
//   • Web push — every stored subscription (dead 404/410 endpoints pruned)
//   • WhatsApp — the owner's number via Meta's Cloud API
// Channels are independently env-gated; nothing urgent → nothing sent.
//
// Auth: same CRON_SECRET bearer scheme as availability-sync. The /api/cron
// prefix is already public in the proxy middleware; this route authenticates
// itself.
import { createAdminClient } from "@/lib/supabase/admin";
import { getNotifications } from "@/lib/notifications";
import { composeMorningPush } from "@/lib/push-compute";
import { pushConfigured, sendPushToSubscriptions } from "@/lib/push";
import { whatsappConfigured, sendWhatsAppAlert } from "@/lib/whatsapp";
import { generateDailySocialPosts } from "@/lib/social/generate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const wantsPush = pushConfigured();
  const wantsWa = whatsappConfigured();
  if (!wantsPush && !wantsWa) {
    return Response.json({ ok: true, configured: false, note: "no channel configured (VAPID / WhatsApp env missing) — nothing sent" });
  }

  let admin;
  try { admin = createAdminClient(); }
  catch (e: any) { return Response.json({ ok: false, error: e?.message ?? "service role unavailable" }, { status: 500 }); }

  try {
    // Draft today's social post FIRST (env-gated, idempotent) so the freshly
    // created pending row shows up in the alerts below — the morning push then
    // carries «منشور اليوم جاهز للمراجعة» pointing at /social.
    let social: Record<string, unknown> = { enabled: false };
    try {
      const g = await generateDailySocialPosts(admin);
      social = g as unknown as Record<string, unknown>;
    } catch (e) {
      social = { enabled: true, created: 0, skipped: e instanceof Error ? e.message : "generate failed" };
    }

    const { items } = await getNotifications();
    const payload = composeMorningPush(items);
    if (!payload) return Response.json({ ok: true, allClear: true, sent: 0, social });

    // Web push (independent of WhatsApp — a failure in one never blocks the other).
    let push: Record<string, unknown> = { configured: false };
    if (wantsPush) {
      const { data: subs, error } = await admin
        .from("push_subscriptions")
        .select("endpoint, p256dh, auth")
        .limit(500);
      if (error) {
        const hint = /push_subscriptions/.test(error.message)
          ? " — run supabase/push_subscriptions.sql once in the SQL editor"
          : "";
        push = { configured: true, error: error.message + hint };
      } else if (!subs?.length) {
        push = { configured: true, subscriptions: 0, sent: 0 };
      } else {
        const res = await sendPushToSubscriptions(subs, payload);
        if (res.pruned.length) {
          await admin.from("push_subscriptions").delete().in("endpoint", res.pruned);
        }
        push = { configured: true, subscriptions: subs.length, sent: res.sent, failed: res.failed, pruned: res.pruned.length };
      }
    }

    // WhatsApp (template mode for the business-initiated daily send).
    let whatsapp: Record<string, unknown> = { configured: false };
    if (wantsWa) {
      const r = await sendWhatsAppAlert(payload.body);
      whatsapp = { configured: true, ok: r.ok, mode: r.mode, ...(r.error ? { error: r.error } : {}) };
    }

    return Response.json({ ok: true, body: payload.body, push, whatsapp, social });
  } catch (e: any) {
    return Response.json({ ok: false, error: e?.message ?? "notify failed" }, { status: 500 });
  }
}
