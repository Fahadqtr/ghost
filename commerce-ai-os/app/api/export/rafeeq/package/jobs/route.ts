// RAFEEQ.PKGJOB — start a chunked package-generation job (SERVER-ONLY, writer-gated).
//
// POST { mode: "full" | "new_pending" } → JSON job status. Idempotent: a live
// running job for the mode is returned, never duplicated. The heavy work runs
// in bounded step requests (…/jobs/<id> POST) — this endpoint only plans the
// job, so it returns quickly and never buffers images or ZIP bytes.
// Responses are ALWAYS structured JSON — never an HTML error page.

import { requireMalakWriter } from "@/lib/malak/authz";
import { startRafeeqPackageJob } from "@/lib/rafeeq/package-job.server";
import { rafeeqJobErrorMessageAr } from "@/lib/export/rafeeq/package-job-errors";
import type { RafeeqFullSyncMode } from "@/lib/export/rafeeq/fullsync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const MODE: Record<string, RafeeqFullSyncMode> = { full: "FULL", new_pending: "NEW" };

const jsonRes = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export async function POST(req: Request) {
  const writer = await requireMalakWriter();
  if (!writer.ok) return jsonRes({ error: "forbidden", message_ar: writer.error }, writer.status);

  let mode: RafeeqFullSyncMode | null = null;
  try {
    const body = await req.json();
    mode = MODE[String(body?.mode ?? "")] ?? null;
  } catch {
    /* fall through to the 422 below */
  }
  if (!mode) return jsonRes({ error: "bad_mode", message_ar: "وضع توليد غير معروف." }, 422);

  const result = await startRafeeqPackageJob({ mode, actor: writer.email });
  if (!result.ok) return jsonRes({ error: result.error, message_ar: rafeeqJobErrorMessageAr(result.error) }, result.status);
  return jsonRes(result.value, 200);
}
