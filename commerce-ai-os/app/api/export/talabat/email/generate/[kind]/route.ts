// TALABAT EMAIL ARTIFACTS — owner-only generation trigger (SERVER-ONLY).
//
// POST → build and store the artifacts for ONE email kind by calling the STEP
//        84 generator. No second generation engine exists: this route resolves
//        the delta from the certified comparison and hands it over.
//
// Generation writes ONLY under email-artifacts/<kind>/ and sends nothing.

import { requireOwner } from "@/lib/malak/authz";
import { generateTalabatEmailArtifacts } from "@/lib/talabat/email-workflow.server";
// GENERATION vocabulary, not the send vocabulary: this route never contacts a
// mail provider, so it must never be able to report that one failed.
import { generationErrorMessageAr } from "@/lib/export/talabat/email-artifacts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const jsonRes = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export async function POST(_req: Request, { params }: { params: Promise<{ kind: string }> }) {
  const owner = await requireOwner();
  if (!owner.ok) return jsonRes({ error: "forbidden", message_ar: owner.error }, owner.status);
  const { kind } = await params;
  const result = await generateTalabatEmailArtifacts(kind);
  if (!result.ok) {
    return jsonRes({ error: result.error, message_ar: generationErrorMessageAr(result.error) }, result.status);
  }
  return jsonRes(result.value, 200);
}
