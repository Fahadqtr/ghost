// TALABAT.PKGJOB — start (or resume) the chunked package job. STEP 74.
//
// WRITER-gated, exactly like the single-shot route it replaces. This handler
// performs NO image work: it loads the certified preview, writes the plan and
// returns a job id — so the START request can never approach the function
// timeout that the single-shot path hit (measured ~785 s of work).
//
// Idempotent: a live job for talabat:malikas is RETURNED rather than duplicated,
// so a double-click cannot create competing jobs.

import { requireMalakWriter } from "@/lib/malak/authz";
import { startTalabatPackageJob } from "@/lib/talabat/package-job.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // start only: preview read + plan write

export async function POST(req: Request) {
  const writer = await requireMalakWriter();
  if (!writer.ok) return Response.json({ error: "forbidden" }, { status: writer.status });

  let mode: "ready" | "selected" = "ready";
  let selectedKeys: string[] | undefined;
  try {
    const body = await req.json();
    if (body?.mode === "selected") {
      mode = "selected";
      selectedKeys = Array.isArray(body?.selectedKeys)
        ? body.selectedKeys.map((v: unknown) => String(v ?? "")).filter(Boolean)
        : [];
    }
  } catch {
    /* no body → default: Generate Ready Only */
  }

  const res = await startTalabatPackageJob({ mode, selectedKeys, actor: writer.email });
  if (!res.ok) return Response.json({ error: res.error }, { status: res.status });
  return Response.json(res.value, { status: 200, headers: { "Cache-Control": "no-store" } });
}
