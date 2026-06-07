// Lightweight public probe: which commit is actually live on Vercel + which
// Malak write features are compiled in. Helps tell a stale browser cache apart
// from a stalled/old deployment.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({
    marker: "phase2c-forcedtool-fetchimage",
    features: ["forced_tool", "set_image", "list_missing_images", "no_store_malak"],
    commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
    ref: process.env.VERCEL_GIT_COMMIT_REF ?? null,
    deployment: process.env.VERCEL_DEPLOYMENT_ID ?? null,
    now: new Date().toISOString(),
  });
}
