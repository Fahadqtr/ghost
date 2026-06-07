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
    marker: "v2h-imagegen-recheck",
    commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
    ref: process.env.VERCEL_GIT_COMMIT_REF ?? null,
    env: {
      OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
      OPENAI_IMAGE_MODEL: process.env.OPENAI_IMAGE_MODEL ?? "(default gpt-image-1-mini)",
      ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
      ELEVENLABS_API_KEY: !!process.env.ELEVENLABS_API_KEY,
      SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    },
    now: new Date().toISOString(),
  });
}
