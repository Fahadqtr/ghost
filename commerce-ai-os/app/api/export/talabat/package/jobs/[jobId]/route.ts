// TALABAT.PKGJOB — one bounded step (POST) / current status (GET). STEP 74.
//
// POST advances the job by exactly ONE bounded step (a small image batch, or
// the archive/mapping/finalize step) and returns the new status. GET is a pure
// read used by the progress poller. Both are writer-gated.

import { requireMalakWriter } from "@/lib/malak/authz";
import { getTalabatPackageJob, stepTalabatPackageJob } from "@/lib/talabat/package-job.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // ONE bounded step, never the whole package

export async function POST(_req: Request, ctx: { params: Promise<{ jobId: string }> }) {
  const writer = await requireMalakWriter();
  if (!writer.ok) return Response.json({ error: "forbidden" }, { status: writer.status });
  const { jobId } = await ctx.params;
  const res = await stepTalabatPackageJob(jobId);
  if (!res.ok) return Response.json({ error: res.error }, { status: res.status });
  return Response.json(res.value, { status: 200, headers: { "Cache-Control": "no-store" } });
}

export async function GET(_req: Request, ctx: { params: Promise<{ jobId: string }> }) {
  const writer = await requireMalakWriter();
  if (!writer.ok) return Response.json({ error: "forbidden" }, { status: writer.status });
  const { jobId } = await ctx.params;
  const res = await getTalabatPackageJob(jobId);
  if (!res.ok) return Response.json({ error: res.error }, { status: res.status });
  return Response.json(res.value, { status: 200, headers: { "Cache-Control": "no-store" } });
}
