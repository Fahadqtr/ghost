import { createAdminClient } from "@/lib/supabase/admin";
import { parseTalabatOrder } from "@/lib/talabat/order-compute";

// Talabat / Delivery Hero ORDER webhook receiver. Register this URL in the
// Vendor Portal (Order Webhook Settings):
//   https://<app>/api/webhooks/talabat/<TALABAT_WEBHOOK_TOKEN>
// The token in the path is the shared secret (calendar/webhook apps can't send
// auth headers reliably). We store the FULL raw payload + best-effort fields and
// always 200 quickly so Delivery Hero doesn't retry/disable the endpoint.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function clean(v: string | undefined): string { return String(v ?? "").trim().replace(/^["']|["']$/g, ""); }

function tokenOk(given: string): boolean {
  const want = clean(process.env.TALABAT_WEBHOOK_TOKEN);
  if (!want || !given || given.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= given.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  if (!tokenOk(String(token || ""))) return new Response("Not found", { status: 404 });

  // Read the body defensively — keep the raw text even if it isn't valid JSON.
  const rawText = await req.text().catch(() => "");
  let payload: any = null;
  try { payload = rawText ? JSON.parse(rawText) : null; } catch { payload = { _unparsed: rawText.slice(0, 20000) }; }

  const p = parseTalabatOrder(payload);
  const event = req.headers.get("x-event-type") || req.headers.get("x-dh-event") || (payload && (payload.event || payload.type)) || null;

  try {
    const admin = createAdminClient();
    const { error } = await admin.from("talabat_orders").insert({
      order_code: p.orderId || null,
      status: p.status || null,
      customer_name: p.customerName || null,
      total: p.total,
      currency: p.currency || null,
      placed_at: p.placedAt || null,
      items: p.items,
      raw: payload ?? { _empty: true },
      event: event ? String(event).slice(0, 80) : null,
    });
    if (error) console.error("[talabat-webhook] insert", error.message);
  } catch (e: any) {
    // Never fail the webhook on our side — log and still ack so DH won't disable it.
    console.error("[talabat-webhook] threw", e?.message || e);
  }

  // Ack fast. (Accept/status updates back to the Order API are a later phase.)
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
}

// A GET on the same URL is handy for a quick "is it reachable?" check.
export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  if (!tokenOk(String(token || ""))) return new Response("Not found", { status: 404 });
  return new Response(JSON.stringify({ ok: true, endpoint: "talabat-order-webhook", ready: true }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
}
