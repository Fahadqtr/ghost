import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { upsertDmConversation, insertDmMessage, autoReplyDm, ensureDmUsername } from "@/lib/dm/inbox";
import {
  verifyMetaSignature,
  resolveSubscriptionChallenge,
  WEBHOOK_NOT_CONFIGURED_MESSAGE,
  WEBHOOK_INVALID_SIGNATURE_MESSAGE,
} from "@/lib/meta/signature";

// Meta webhook (Instagram DMs now; WhatsApp joins later on the same endpoint).
// GET  = subscription verification (hub.challenge echo, via META_VERIFY_TOKEN).
// POST = message events → store → «ملاك» auto-reply. The POST body is
// authenticated with an HMAC signature (META_APP_SECRET) BEFORE anything is
// parsed, logged, written, or sent — and we fail CLOSED if that secret is
// absent. Once verified we answer 200 fast; Meta retries on non-200 and the
// mid-dedupe makes retries harmless.

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const challenge = resolveSubscriptionChallenge(
    p.get("hub.mode"),
    p.get("hub.verify_token"),
    p.get("hub.challenge"),
    process.env.META_VERIFY_TOKEN
  );
  if (challenge !== null) return new NextResponse(challenge, { status: 200 });
  return new NextResponse("forbidden", { status: 403 });
}

export async function POST(req: NextRequest) {
  // Read the raw body exactly once — required verbatim for HMAC verification.
  const raw = await req.text();

  const signature = verifyMetaSignature(
    raw,
    req.headers.get("x-hub-signature-256"),
    process.env.META_APP_SECRET
  );

  // Fail CLOSED: without the signing secret we cannot authenticate Meta, so we
  // refuse to parse, log, touch the DB, call AI, or send any Instagram DM.
  if (signature === "not_configured") {
    return new NextResponse(WEBHOOK_NOT_CONFIGURED_MESSAGE, { status: 503 });
  }
  // Missing / malformed / wrong signature → reject with no side effects and
  // without echoing the digest, secret, or raw body.
  if (signature !== "ok") {
    return new NextResponse(WEBHOOK_INVALID_SIGNATURE_MESSAGE, { status: 401 });
  }

  // Signature verified — only now do we parse and process the event.
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
          // Backfill the customer's real IG name once (best-effort) so the
          // inbox shows a handle instead of a bare numeric ID.
          if (!convo.username) await ensureDmUsername(admin, convo.id, senderId).catch(() => {});

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
