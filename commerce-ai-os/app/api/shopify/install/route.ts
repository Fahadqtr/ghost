// Starts the Shopify OAuth grant: sets a state cookie and bounces the owner
// to the store's approval screen. Owner-only (behind the auth middleware).
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import crypto from "crypto";
import { isSignedIn } from "@/lib/auth/requireUser";
import { buildAuthorizeUrl } from "@/lib/shopify/oauth-compute";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!(await isSignedIn())) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const shop = String(process.env.SHOPIFY_STORE_DOMAIN ?? "").trim();
  const clientId = String(process.env.SHOPIFY_CLIENT_ID ?? "").trim();
  if (!shop || !clientId) {
    return Response.json({ ok: false, error: "أضف SHOPIFY_STORE_DOMAIN و SHOPIFY_CLIENT_ID و SHOPIFY_CLIENT_SECRET في Vercel أولًا." }, { status: 400 });
  }

  const state = crypto.randomBytes(16).toString("hex");
  const jar = await cookies();
  jar.set("shopify_oauth_state", state, { httpOnly: true, secure: true, sameSite: "lax", maxAge: 600, path: "/" });

  const origin = new URL(req.url).origin;
  redirect(buildAuthorizeUrl({ shop, clientId, redirectUri: `${origin}/api/shopify/callback`, state }));
}
