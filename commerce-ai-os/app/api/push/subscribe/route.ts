// Save / remove this browser's web-push subscription. Owner-only (requires a
// logged-in Supabase session — the middleware already walls this path off from
// anonymous traffic). Rows are stored via the service-role client because
// push_subscriptions has RLS with no user policies.
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseSubscription } from "@/lib/push-compute";
import { pushConfigured } from "@/lib/push";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function requireOwner(): Promise<Response | null> {
  const { data: { user } } = await createClient().auth.getUser();
  if (!user) return Response.json({ ok: false, error: "غير مسجّل الدخول." }, { status: 401 });
  return null;
}

export async function POST(req: Request) {
  const denied = await requireOwner();
  if (denied) return denied;
  if (!pushConfigured()) {
    return Response.json({ ok: false, error: "الإشعارات غير مهيأة على الخادم (مفاتيح VAPID ناقصة)." }, { status: 200 });
  }

  const body = await req.json().catch(() => null);
  const sub = parseSubscription(body);
  if (!sub) return Response.json({ ok: false, error: "اشتراك غير صالح." }, { status: 400 });

  try {
    const admin = createAdminClient();
    const { error } = await admin
      .from("push_subscriptions")
      .upsert(
        { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth },
        { onConflict: "endpoint" },
      );
    if (error) {
      const hint = /push_subscriptions/.test(error.message)
        ? " — شغّل supabase/push_subscriptions.sql مرة وحدة في SQL Editor."
        : "";
      return Response.json({ ok: false, error: error.message + hint }, { status: 500 });
    }
    return Response.json({ ok: true });
  } catch (e: any) {
    return Response.json({ ok: false, error: e?.message ?? "subscribe failed" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const denied = await requireOwner();
  if (denied) return denied;

  const body = await req.json().catch(() => null);
  const endpoint = typeof (body as any)?.endpoint === "string" ? (body as any).endpoint : "";
  if (!endpoint) return Response.json({ ok: false, error: "endpoint مطلوب." }, { status: 400 });

  try {
    const admin = createAdminClient();
    await admin.from("push_subscriptions").delete().eq("endpoint", endpoint);
    return Response.json({ ok: true });
  } catch (e: any) {
    return Response.json({ ok: false, error: e?.message ?? "unsubscribe failed" }, { status: 500 });
  }
}
