// TEMPORARY public version probe — confirms exactly which commit is live on
// Vercel (so we can tell a stale browser cache from a not-yet-deployed push).
// Remove once the Phase 2B write flow is confirmed working.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({
    marker: "phase2b-forced-tool",
    commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
    ref: process.env.VERCEL_GIT_COMMIT_REF ?? null,
    builtAt: process.env.VERCEL_DEPLOYMENT_ID ?? null,
    now: new Date().toISOString(),
  });
}
