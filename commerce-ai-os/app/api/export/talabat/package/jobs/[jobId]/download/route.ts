// TALABAT.PKGJOB — stream a COMPLETED job's artifact. STEP 74.
//
// The artifact is the ordered concatenation of the durable parts, streamed
// part-by-part so the ~800 MB archive is never buffered whole in memory —
// the same constraint that made the single-shot generator impossible.

import { requireMalakWriter } from "@/lib/malak/authz";
import { getTalabatPackageArtifact, readTalabatPackagePart } from "@/lib/talabat/package-job.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(_req: Request, ctx: { params: Promise<{ jobId: string }> }) {
  const writer = await requireMalakWriter();
  if (!writer.ok) return new Response("forbidden", { status: writer.status });
  const { jobId } = await ctx.params;

  const art = await getTalabatPackageArtifact(jobId);
  if (!art.ok) return new Response("not found", { status: 404 });

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (const path of art.parts) {
        const bytes = await readTalabatPackagePart(path);
        if (!bytes) { controller.error(new Error("part missing")); return; }
        controller.enqueue(bytes);
      }
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${art.filename}"`,
      "Content-Length": String(art.totalBytes),
      "Cache-Control": "no-store",
    },
  });
}
