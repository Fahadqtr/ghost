// TEMP deploy probe — confirms the live commit. Remove after verifying.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  return Response.json({
    commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
    now: new Date().toISOString(),
  });
}
