// GET /api/integrations/ticktick/callback — owner-only OAuth callback.
// Verifies the CSRF state cookie, exchanges the authorization code for a token
// SERVER-SIDE, and shows a single fixed Arabic message. The access token is
// NEVER shown, stored (no DB), or logged. No admin client, no service role, no
// SQL/RPC. Every failure is a fixed Arabic message — no raw provider error leaks.
import { cookies } from "next/headers";
import { requireOwner } from "@/lib/malak/authz";
import {
  parseCallbackParams,
  validateState,
  exchangeCodeForToken,
  oauthMessage,
  type OAuthMessageCode,
} from "@/lib/integrations/ticktick/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATE_COOKIE = "tt_oauth_state";

function clean(v: string | undefined): string {
  return String(v ?? "").trim();
}

/** A minimal RTL page carrying ONLY a fixed message (never a token/secret). */
function page(message: string, status: number): Response {
  const body = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>ربط TickTick</title></head><body style="font-family:system-ui,sans-serif;padding:2rem;text-align:center;color:#2b2b2b">${message}</body></html>`;
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

function fail(code: OAuthMessageCode, status: number): Response {
  return page(oauthMessage(code), status);
}

export async function GET(req: Request) {
  const owner = await requireOwner();
  if (!owner.ok) return page(owner.error, owner.status);

  // Read + clear the one-time CSRF state cookie.
  const jar = await cookies();
  const cookieState = jar.get(STATE_COOKIE)?.value ?? "";
  jar.delete(STATE_COOKIE);

  const { code, state, error } = parseCallbackParams(new URL(req.url).searchParams);
  if (error) return fail("provider_error", 400); // the raw error param is never echoed
  if (!validateState(cookieState, state)) return fail("invalid_state", 400);
  if (!code) return fail("missing_code", 400);

  const clientId = clean(process.env.TICKTICK_CLIENT_ID);
  const clientSecret = clean(process.env.TICKTICK_CLIENT_SECRET);
  const redirectUri = clean(process.env.TICKTICK_REDIRECT_URI);
  if (!clientId || !clientSecret || !redirectUri) return fail("not_configured", 400);

  const result = await exchangeCodeForToken({ code, clientId, clientSecret, redirectUri });
  if (!result.ok) return fail(result.code, 502);

  // Success — the token is intentionally NOT part of this response.
  return page(oauthMessage("success"), 200);
}
