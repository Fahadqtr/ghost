// RAFEEQ.PKGLINK — owner-only signed direct-download link for a COMPLETED
// package's certified stored artifact.
//
// POST → { url, expiresAtIso, filename, bytes, sha256 }. Idempotently ensures
// the single certified object exists in the private bucket (assembled from
// the already-stored parts — never regenerated), then creates a fresh scoped
// signed URL (default 7 days) served DIRECTLY by Supabase Storage/CDN. Every
// call yields a fresh link, so refreshing an expired link is just calling
// again. Owner-gated: non-owners cannot generate links.

import { requireOwner } from "@/lib/malak/authz";
import { createRafeeqPackageSignedLink } from "@/lib/rafeeq/artifact-object.server";
import { rafeeqSendErrorMessageAr } from "@/lib/export/rafeeq/email-send";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const jsonRes = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export async function POST(_req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const owner = await requireOwner();
  if (!owner.ok) return jsonRes({ error: "forbidden", message_ar: owner.error }, owner.status);
  const { jobId } = await params;
  const result = await createRafeeqPackageSignedLink(jobId);
  if (!result.ok) return jsonRes({ error: result.error, message_ar: rafeeqSendErrorMessageAr(result.error) }, result.status);
  return jsonRes(result.value, 200);
}
