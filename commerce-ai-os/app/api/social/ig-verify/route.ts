// Phase 0 verification endpoint. Open this (signed in) AFTER setting the Meta
// token in Vercel: it resolves IG_USER_ID from the token, reads the username,
// and creates a Reels container (never publishes) to prove content-publishing
// works. Returns a plain-Arabic summary + the value to lock into Vercel.
import { verifyIgSetup } from "@/lib/social/instagram";
import { requireUser } from "@/lib/auth/requireUser";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const unauth = await requireUser();
  if (unauth) return Response.json({ error: unauth.error }, { status: 401 });
  const result = await verifyIgSetup();
  return Response.json(result, { status: result.ok ? 200 : 200 });
}
