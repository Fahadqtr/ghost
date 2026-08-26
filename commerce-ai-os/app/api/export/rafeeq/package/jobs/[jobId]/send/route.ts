// RAFEEQ DIRECT SEND — owner-only email of a COMPLETED package (SERVER-ONLY).
//
// GET  → preflight JSON the confirmation modal renders (From/Subject/
//        attachments + exact sizes/limits/counts). READ-ONLY.
// POST → transmit ONE email after the owner's explicit «إرسال الآن»
//        confirmation. Operates only on the stored completed artifact —
//        never regenerates, never touches rafeeq_packages.sent_at (the
//        Rafeeq SENT baseline stays a separate explicit owner action).
//        Audit row is written only after the provider accepted the message.

import { requireOwner } from "@/lib/malak/authz";
import { getRafeeqEmailSendPreflight, sendRafeeqPackageEmail } from "@/lib/rafeeq/email-send.server";
import { rafeeqSendErrorMessageAr } from "@/lib/export/rafeeq/email-send";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const jsonRes = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export async function GET(_req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const owner = await requireOwner();
  if (!owner.ok) return jsonRes({ error: "forbidden", message_ar: owner.error }, owner.status);
  const { jobId } = await params;
  const result = await getRafeeqEmailSendPreflight(jobId);
  if (!result.ok) return jsonRes({ error: result.error, message_ar: rafeeqSendErrorMessageAr(result.error) }, result.status);
  return jsonRes(result.value, 200);
}

export async function POST(req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const owner = await requireOwner();
  if (!owner.ok) return jsonRes({ error: "forbidden", message_ar: owner.error }, owner.status);
  const { jobId } = await params;
  let body: { to?: unknown; cc?: unknown; includeZip?: unknown; saveRecipient?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonRes({ error: "invalid_recipient", message_ar: rafeeqSendErrorMessageAr("invalid_recipient") }, 400);
  }
  const result = await sendRafeeqPackageEmail(jobId, {
    toRaw: typeof body.to === "string" ? body.to : "",
    ccRaw: typeof body.cc === "string" ? body.cc : "",
    includeZip: body.includeZip === true,
    saveRecipient: body.saveRecipient === true,
  });
  if (!result.ok) return jsonRes({ error: result.error, message_ar: rafeeqSendErrorMessageAr(result.error) }, result.status);
  return jsonRes(result.value, 200);
}
