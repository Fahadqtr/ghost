import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { upsertDmConversation, insertDmMessage, autoReplyDm } from "@/lib/dm/inbox";

// Meta webhook (Instagram DMs now; WhatsApp joins later on the same endpoint).
// GET  = subscription verification (hub.challenge echo).
// POST = message events → store → «ملاك» auto-reply. Always 200 fast; Meta
// retries on non-200 and the mid-dedupe makes retries harmless.

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const verify = process.env.META_VERIFY_TOKEN || "";
  if (p.get("hub.mode") === "subscribe" && verify && p.get("hub.verify_token") === verify) {
    return new NextResponse(p.get("hub.challenge") ?? "", { status: 200 });
  }
  return new NextResponse("forbidden", { status: 403 });
}

/** X-Hub-Signature-256 check — enforced only when META_APP_SECRET is set. */
function signatureOk(raw: string, header: string | null): boolean {
  const secret = process.env.META_APP_SECRET;
  if (!secret) return true;
  if (!header?.startsWith("sha256=")) return false;
  const expected = crypto.createHmac("sha256", secret).update(raw, "utf8").digest("hex");
  const got = header.slice(7);
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(got, "hex"));
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  const raw = await req.text();
  if (!signatureOk(raw, req.headers.get("x-hub-signature-256"))) {
    return new NextResponse("bad signature", { status: 401 });
  }

  let payload: any;
  try { payload = JSON.parse(raw); } catch { return NextResponse.json({ ok: true }); }

  try {
    const admin = createAdminClient();
    const object = String(payload?.object ?? "");
    if (object === "instagram" || object === "page") {
      for (const entry of payload?.entry ?? []) {
        for (const ev of entry?.messaging ?? []) {
          const senderId = String(ev?.sender?.id ?? "");
          const text = String(ev?.message?.text ?? "").trim();
          const mid = ev?.message?.mid ? String(ev.message.mid) : null;
          // Skip our own echoes, deliveries/reads, and empty senders.
          if (!senderId || ev?.message?.is_echo) continue;
          if (!ev?.message) continue;

          const convo = await upsertDmConversation(admin, "instagram", senderId);
          if (!convo) continue;

          if (!text) {
            // Attachment/voice/share — store a placeholder and hand off.
            await insertDmMessage(admin, { conversationId: convo.id, direction: "in", body: "📎 (مرفق/صورة)", mid });
            await admin.from("dm_conversations").update({ needs_human: true }).eq("id", convo.id);
            continue;
          }

          const fresh = await insertDmMessage(admin, { conversationId: convo.id, direction: "in", body: text, mid });
          if (!fresh) continue; // webhook retry — already answered
          await autoReplyDm(admin, convo, senderId);
        }
      }
    }
  } catch (e) {
    console.error("[meta-webhook]", e instanceof Error ? e.message : e);
  }
  return NextResponse.json({ ok: true });
}
