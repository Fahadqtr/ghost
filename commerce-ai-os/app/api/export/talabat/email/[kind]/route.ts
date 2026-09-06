// TALABAT DIRECT SEND — owner-only preflight + send for ONE email kind.
//
// GET  → preflight JSON the confirmation screen renders: sender/transport
//        truth, configured recipients, attachment set, scope facts and every
//        blocker in owner language. READ-ONLY — nothing is generated or sent.
// POST → transmit ONE email, and ONLY after the owner's explicit confirm flag.
//        Generation never implies a send; a request without `confirm: true` is
//        refused by the pure planner with not_confirmed.
//
// `kind` is a path segment, so the barcode-review email is rejected here by
// name as well as by the planner: there is no route that can carry it.

import { requireOwner } from "@/lib/malak/authz";
import { getTalabatSendPreflight, sendTalabatEmail } from "@/lib/talabat/email-send.server";
import { talabatSendErrorMessageAr } from "@/lib/export/talabat/email-send";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const jsonRes = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export async function GET(req: Request, { params }: { params: Promise<{ kind: string }> }) {
  const owner = await requireOwner();
  if (!owner.ok) return jsonRes({ error: "forbidden", message_ar: owner.error }, owner.status);
  const { kind } = await params;
  const url = new URL(req.url);
  const requests = url.searchParams.getAll("categoryRequest");
  // The caller states which comparison run it is acting on. Absent is not the
  // same as matching — the preflight reports it as a blocker.
  const runFingerprint = url.searchParams.get("run");
  const result = await getTalabatSendPreflight(kind, requests, runFingerprint);
  if (!result.ok) return jsonRes({ error: result.error, message_ar: talabatSendErrorMessageAr(result.error) }, result.status);
  return jsonRes(result.value, 200);
}

export async function POST(req: Request, { params }: { params: Promise<{ kind: string }> }) {
  const owner = await requireOwner();
  if (!owner.ok) return jsonRes({ error: "forbidden", message_ar: owner.error }, owner.status);
  const { kind } = await params;
  let body: { confirm?: unknown; categoryRequests?: unknown; run?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonRes({ error: "not_confirmed", message_ar: talabatSendErrorMessageAr("not_confirmed") }, 428);
  }
  const result = await sendTalabatEmail({
    kind,
    // strictly `=== true`: a truthy string or 1 is not an owner confirmation.
    confirm: body.confirm === true,
    categoryRequests: stringList(body.categoryRequests),
    createdBy: owner.email,
    currentRunFingerprint: typeof body.run === "string" && body.run !== "" ? body.run : null,
  });
  if (!result.ok) return jsonRes({ error: result.error, message_ar: talabatSendErrorMessageAr(result.error) }, result.status);
  return jsonRes(result.value, 200);
}
