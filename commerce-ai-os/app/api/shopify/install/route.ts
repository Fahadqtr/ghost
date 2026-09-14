// Starts the Shopify OAuth grant: sets a state cookie and bounces the owner
// to the store's approval screen.
//
// D-4A2 — OWNER-ONLY, and it must stay that way. This route opens the grant
// whose callback mints and stores a PERMANENT Shopify Admin API token, so
// "any signed-in account" was never the intended boundary (the line above has
// said "Owner-only" since this route was written — the code just enforced the
// weaker session check). requireOwner() returns its own 401/403 status, so the
// denial keeps proper HTTP semantics instead of collapsing to a flat 401.
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import crypto from "crypto";
import { requireOwner } from "@/lib/malak/authz";
import { buildAuthorizeUrl } from "@/lib/shopify/oauth-compute";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const owner = await requireOwner();
  if (!owner.ok) return Response.json({ ok: false, error: owner.error }, { status: owner.status });

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
