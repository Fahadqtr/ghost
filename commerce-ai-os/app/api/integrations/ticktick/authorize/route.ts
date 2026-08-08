// GET /api/integrations/ticktick/authorize — owner-only OAuth start.
// Sets a CSRF state cookie (httpOnly, server-side) and redirects to the official
// TickTick authorization URL. No secret is ever sent to the browser (only the
// public client_id / redirect_uri / scope / state travel in the redirect).
import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requireOwner } from "@/lib/malak/authz";
import { buildAuthorizeUrl } from "@/lib/integrations/ticktick/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATE_COOKIE = "tt_oauth_state";
const COOKIE_PATH = "/api/integrations/ticktick";

function clean(v: string | undefined): string {
  return String(v ?? "").trim();
}

export async function GET() {
  const owner = await requireOwner();
  if (!owner.ok) return Response.json({ ok: false, error: owner.error }, { status: owner.status });

  const clientId = clean(process.env.TICKTICK_CLIENT_ID);
  const redirectUri = clean(process.env.TICKTICK_REDIRECT_URI);
  if (!clientId || !redirectUri) {
    return Response.json({ ok: false, error: "TickTick غير مهيأ." }, { status: 400 });
  }

  // Random CSRF state, stored server-side in an httpOnly cookie and echoed back
  // by TickTick on the callback (verified there).
  const state = randomBytes(16).toString("hex");
  const jar = await cookies();
  jar.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: COOKIE_PATH,
    maxAge: 600,
  });

  redirect(buildAuthorizeUrl({ clientId, redirectUri, state }));
}
