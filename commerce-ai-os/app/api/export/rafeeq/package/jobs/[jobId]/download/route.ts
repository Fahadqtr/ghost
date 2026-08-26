// RAFEEQ.PKGJOB — streamed artifact download (SERVER-ONLY, writer-gated).
//
// The completed artifact lives in durable storage as ordered ZIP parts; this
// route STREAMS them one part at a time (bounded memory — the full ~500 MiB
// archive is NEVER buffered in the function). Content-Length is exact, so the
// browser shows real download progress. Failure responses are structured JSON.

import { requireMalakWriter } from "@/lib/malak/authz";
import { getRafeeqPackageArtifact, readRafeeqPackagePart } from "@/lib/rafeeq/package-job.server";
import { rafeeqJobErrorMessageAr } from "@/lib/export/rafeeq/package-job-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const jsonRes = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export async function GET(_req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const writer = await requireMalakWriter();
  if (!writer.ok) return jsonRes({ error: "forbidden", message_ar: writer.error }, writer.status);
  const { jobId } = await params;

  const artifact = await getRafeeqPackageArtifact(jobId);
  if (!artifact.ok) return jsonRes({ error: artifact.error, message_ar: rafeeqJobErrorMessageAr(artifact.error) }, artifact.status);
  const { filename, totalBytes, parts } = artifact.value;

  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index >= parts.length) {
        controller.close();
        return;
      }
      const part = parts[index];
      index += 1;
      const bytes = await readRafeeqPackagePart(part.path);
      if (!bytes || bytes.length !== part.bytes) {
        controller.error(new Error(`artifact part unreadable: ${part.path}`));
        return;
      }
      controller.enqueue(bytes);
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Length": String(totalBytes),
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
