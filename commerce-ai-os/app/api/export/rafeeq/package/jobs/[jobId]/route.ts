// RAFEEQ.PKGJOB — job status (GET) + one bounded generation step (POST).
//
// The UI drives the job by POSTing steps until status is complete/failed; each
// step fetches a small image batch and commits ONE durable ZIP part — bounded
// memory, bounded time, resumable after any interruption. Concurrent drivers
// are safe (optimistic step claim). Responses are ALWAYS structured JSON.

import { requireMalakWriter } from "@/lib/malak/authz";
import { getRafeeqPackageJob, stepRafeeqPackageJob } from "@/lib/rafeeq/package-job.server";
import { rafeeqJobErrorMessageAr } from "@/lib/export/rafeeq/package-job-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const jsonRes = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export async function GET(_req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const writer = await requireMalakWriter();
  if (!writer.ok) return jsonRes({ error: "forbidden", message_ar: writer.error }, writer.status);
  const { jobId } = await params;
  const result = await getRafeeqPackageJob(jobId);
  if (!result.ok) return jsonRes({ error: result.error, message_ar: rafeeqJobErrorMessageAr(result.error) }, result.status);
  return jsonRes(result.value, 200);
}

export async function POST(_req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const writer = await requireMalakWriter();
  if (!writer.ok) return jsonRes({ error: "forbidden", message_ar: writer.error }, writer.status);
  const { jobId } = await params;
  const result = await stepRafeeqPackageJob(jobId);
  if (!result.ok) return jsonRes({ error: result.error, message_ar: rafeeqJobErrorMessageAr(result.error) }, result.status);
  return jsonRes(result.value, 200);
}
