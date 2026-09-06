// TALABAT EMAIL WORKFLOW — owner-only preview and TEST send (SERVER-ONLY).
//
// GET  → the full preview the V2 screen renders: From, resolved To/CC, subject,
//        body, attachments with sizes, the size verdict, artifact freshness,
//        every blocker in owner language, and the confirmation token for THIS
//        exact message. READ-ONLY.
// POST → send ONE TEST message. The mode is pinned to "test" here; the official
//        send has no route at all in this build, and the pure gate refuses it
//        even if one existed.

import { requireOwner } from "@/lib/malak/authz";
import { buildWorkflowPreview, sendTalabatTestEmail } from "@/lib/talabat/email-workflow.server";
import { WORKFLOW_BLOCK_AR, type WorkflowBlock } from "@/lib/export/talabat/email-workflow";
import { talabatSendErrorMessageAr } from "@/lib/export/talabat/email-send";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const jsonRes = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

const messageAr = (code: string) =>
  WORKFLOW_BLOCK_AR[code as WorkflowBlock] ?? talabatSendErrorMessageAr(code);

const str = (v: unknown) => (typeof v === "string" ? v : "");
const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export async function GET(req: Request, { params }: { params: Promise<{ kind: string }> }) {
  const owner = await requireOwner();
  if (!owner.ok) return jsonRes({ error: "forbidden", message_ar: owner.error }, owner.status);
  const { kind } = await params;
  const url = new URL(req.url);
  const result = await buildWorkflowPreview({
    kind,
    // Only "test" is a real mode today; an "official" preview is still allowed
    // so the owner can SEE the message the official send would carry, and the
    // gate reports official_send_disabled rather than pretending otherwise.
    mode: url.searchParams.get("mode") === "official" ? "official" : "test",
    toRaw: url.searchParams.get("to") ?? "",
    ccRaw: url.searchParams.get("cc") ?? "",
    currentRunFingerprint: url.searchParams.get("run"),
    categoryRequests: url.searchParams.getAll("categoryRequest"),
  });
  if (!result.ok) return jsonRes({ error: result.error, message_ar: messageAr(result.error) }, result.status);
  return jsonRes(result.value, 200);
}

export async function POST(req: Request, { params }: { params: Promise<{ kind: string }> }) {
  const owner = await requireOwner();
  if (!owner.ok) return jsonRes({ error: "forbidden", message_ar: owner.error }, owner.status);
  const { kind } = await params;
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return jsonRes({ error: "not_confirmed", message_ar: messageAr("not_confirmed") }, 428);
  }
  const result = await sendTalabatTestEmail({
    kind,
    mode: "test", // pinned: this route can never carry an official send
    toRaw: str(body.to),
    ccRaw: str(body.cc),
    currentRunFingerprint: typeof body.run === "string" && body.run !== "" ? body.run : null,
    categoryRequests: list(body.categoryRequests),
    confirmationToken: typeof body.confirmationToken === "string" ? body.confirmationToken : null,
    createdBy: owner.email,
  });
  if (!result.ok) return jsonRes({ error: result.error, message_ar: messageAr(result.error) }, result.status);
  return jsonRes(result.value, 200);
}
