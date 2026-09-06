// TALABAT EMAIL B — the new-product IMAGE PACKAGE (owner-only, SERVER-ONLY).
//
// Email B attaches a workbook and links its images; this endpoint is what puts
// those images where the link can point. The work is long — hundreds of fetches
// — so it is driven the way every other Talabat package job is: start once,
// then step repeatedly, then stage the finished archive.
//
// GET  → is a usable package staged for the CURRENT delta?
// POST → { action: "start" | "step" | "stage" }
//
// Nothing here sends mail, and nothing here writes to the catalogue, to a
// marketplace, or to the channel mapping table.

import { requireOwner } from "@/lib/malak/authz";
import { deltaImagePackageStatus, startDeltaImagePackage } from "@/lib/talabat/email-workflow.server";
import { stepTalabatDeltaImageJob, stageTalabatDeltaImagePackage } from "@/lib/talabat/package-job.server";
import { talabatJobErrorMessageAr } from "@/lib/export/talabat/package-job-errors";
import { generationErrorMessageAr } from "@/lib/export/talabat/email-artifacts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The image steps are bounded batches, but each one is dominated by network
// time; the certified package job uses the same ceiling.
export const maxDuration = 300;

const jsonRes = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

// Job vocabulary first (this is a job), then the generation vocabulary for the
// baseline/delta failures that can surface before a job exists. The SEND
// vocabulary is unreachable here — no mail is involved.
const messageAr = (code: string) =>
  code.startsWith("baseline_") || code.startsWith("image_package") || code === "preview_unavailable"
    ? generationErrorMessageAr(code)
    : talabatJobErrorMessageAr(code);

export async function GET() {
  const owner = await requireOwner();
  if (!owner.ok) return jsonRes({ error: "forbidden", message_ar: owner.error }, owner.status);
  const status = await deltaImagePackageStatus();
  if (!status.ok) return jsonRes({ error: status.error, message_ar: messageAr(status.error) }, status.status);
  return jsonRes(status.value, 200);
}

export async function POST(req: Request) {
  const owner = await requireOwner();
  if (!owner.ok) return jsonRes({ error: "forbidden", message_ar: owner.error }, owner.status);

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return jsonRes({ error: "network", message_ar: messageAr("network") }, 400);
  }
  const action = typeof body.action === "string" ? body.action : "";
  const jobId = typeof body.jobId === "string" ? body.jobId : "";

  if (action === "start") {
    const started = await startDeltaImagePackage(owner.email);
    if (!started.ok) return jsonRes({ error: started.error, message_ar: messageAr(started.error) }, started.status);
    return jsonRes(started.value, 200);
  }

  if (action === "step") {
    if (jobId === "") return jsonRes({ error: "job_not_found", message_ar: messageAr("job_not_found") }, 400);
    const stepped = await stepTalabatDeltaImageJob(jobId);
    if (!stepped.ok) return jsonRes({ error: stepped.error, message_ar: messageAr(stepped.error) }, stepped.status);
    return jsonRes(stepped.value, 200);
  }

  if (action === "stage") {
    if (jobId === "") return jsonRes({ error: "job_not_found", message_ar: messageAr("job_not_found") }, 400);
    const staged = await stageTalabatDeltaImagePackage(jobId);
    if (!staged.ok) {
      // An incomplete package returns WHICH images are missing — a count alone
      // is not something an owner can act on.
      return jsonRes({
        error: staged.error, message_ar: messageAr(staged.error),
        ...(staged.coverage ? { coverage: staged.coverage } : {}),
        ...(staged.missingRefs ? { missing: staged.missingRefs.slice(0, 50) } : {}),
      }, staged.status);
    }
    return jsonRes(staged.value, 200);
  }

  return jsonRes({ error: "network", message_ar: messageAr("network") }, 400);
}
