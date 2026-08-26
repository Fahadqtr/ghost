// RAFEEQ.PKGJOB — email DRAFT for a completed generation (SERVER-ONLY,
// writer-gated, READ-ONLY).
//
// GET → JSON { to, subject, html, textAr, attachments, zipTooLargeForEmail }
// built from the ACTUAL completed job's state/plan (counts and option
// examples are real — never hardcoded). This endpoint NEVER sends an email,
// never mutates package history, and never marks anything sent — the human
// copies the draft (or creates their own Gmail draft) and attaches the files.

import { requireMalakWriter } from "@/lib/malak/authz";
import { buildRafeeqEmailDraftForJob } from "@/lib/rafeeq/package-job.server";
import { rafeeqJobErrorMessageAr } from "@/lib/export/rafeeq/package-job-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const jsonRes = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export async function GET(_req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const writer = await requireMalakWriter();
  if (!writer.ok) return jsonRes({ error: "forbidden", message_ar: writer.error }, writer.status);
  const { jobId } = await params;
  const result = await buildRafeeqEmailDraftForJob(jobId);
  if (!result.ok) return jsonRes({ error: result.error, message_ar: rafeeqJobErrorMessageAr(result.error) }, result.status);
  return jsonRes(result.value, 200);
}
