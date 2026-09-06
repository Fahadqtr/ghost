// SETTINGS → EMAIL — owner-only sender/recipient configuration (SERVER-ONLY).
//
// GET  → sender identities with their REAL transport verification state, the
//        configured Talabat and Rafeeq recipients, and the mail-env diagnostic
//        (booleans and variable NAMES only). No credential is ever included.
// POST → save one channel's recipients after strict validation. This is the
//        only write here: it cannot send mail and cannot touch credentials.

import { requireOwner } from "@/lib/malak/authz";
import { getEmailSettings, saveChannelRecipients } from "@/lib/talabat/email-send.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const jsonRes = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export async function GET() {
  const owner = await requireOwner();
  if (!owner.ok) return jsonRes({ error: "forbidden", message_ar: owner.error }, owner.status);
  return jsonRes(await getEmailSettings(), 200);
}

export async function POST(req: Request) {
  const owner = await requireOwner();
  if (!owner.ok) return jsonRes({ error: "forbidden", message_ar: owner.error }, owner.status);
  let body: { channel?: unknown; to?: unknown; cc?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonRes({ error: "invalid_recipient", message_ar: "طلب غير صالح." }, 400);
  }
  const channel = body.channel === "talabat" || body.channel === "rafeeq" ? body.channel : null;
  if (channel === null) return jsonRes({ error: "invalid_channel", message_ar: "قناة غير معروفة." }, 400);
  const saved = await saveChannelRecipients(
    channel,
    typeof body.to === "string" ? body.to : "",
    typeof body.cc === "string" ? body.cc : "",
  );
  if (!saved.ok) {
    return jsonRes({
      error: saved.error,
      invalid: saved.invalid,
      message_ar: saved.emptyTo ? "أدخل عنوان مستلم واحداً على الأقل." : "عنوان البريد غير صالح — تحقق من الحقول.",
    }, 422);
  }
  return jsonRes({ ok: true, channel, ...saved.value }, 200);
}
