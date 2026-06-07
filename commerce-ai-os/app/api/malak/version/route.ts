// Temporary deploy/behavior probe. Confirms which commit is live and lets us
// run the ACTUAL deployed write-intent detector against a phrase.
import { detectForcedTool } from "@/lib/malak/intent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const probe = new URL(req.url).searchParams.get("detect");
  if (probe !== null) {
    return Response.json({ input: probe, detected: detectForcedTool(probe) });
  }
  return Response.json({
    marker: "v2g-forcetool-recheck",
    commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
    ref: process.env.VERCEL_GIT_COMMIT_REF ?? null,
    now: new Date().toISOString(),
  });
}
