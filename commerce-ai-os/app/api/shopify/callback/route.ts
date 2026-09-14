// Completes the Shopify OAuth grant: verifies our state cookie + Shopify's
// HMAC signature, pins the shop to the configured store, exchanges the code
// for the permanent offline Admin token and stores it in shopify_tokens.
//
// D-4A2 — OWNER-ONLY, and it must stay that way. The final step writes a
// PERMANENT Shopify Admin API credential into shopify_tokens on the
// SERVICE-ROLE client, so RLS constrains nothing here and the gate is the only
// boundary. Under the previous signed-in-only check any authenticated account
// that could complete a grant could replace the store's Admin token. The state
// cookie + HMAC checks authenticate SHOPIFY, never the caller — they are not a
// substitute for this gate. requireOwner() carries its own 401/403 status.
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireOwner } from "@/lib/malak/authz";
import { verifyShopifyHmac, isExpectedShop } from "@/lib/shopify/oauth-compute";
import { invalidateShopifyTokenCache } from "@/lib/shopify/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const owner = await requireOwner();
  if (!owner.ok) return Response.json({ ok: false, error: owner.error }, { status: owner.status });

  const url = new URL(req.url);
  const params: Record<string, string> = {};
  url.searchParams.forEach((v, k) => { params[k] = v; });

  const domain = String(process.env.SHOPIFY_STORE_DOMAIN ?? "").trim();
  const clientId = String(process.env.SHOPIFY_CLIENT_ID ?? "").trim();
  const clientSecret = String(process.env.SHOPIFY_CLIENT_SECRET ?? "").trim();
  if (!domain || !clientId || !clientSecret) {
    return Response.json({ ok: false, error: "SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET / SHOPIFY_STORE_DOMAIN غير مكتملة." }, { status: 400 });
  }

  const jar = await cookies();
  const expectedState = jar.get("shopify_oauth_state")?.value ?? "";
  jar.delete("shopify_oauth_state");
  if (!expectedState || params.state !== expectedState) {
    return Response.json({ ok: false, error: "state mismatch — أعد فتح /api/shopify/install." }, { status: 400 });
  }
  if (!isExpectedShop(params.shop ?? "", domain)) {
    return Response.json({ ok: false, error: "shop mismatch." }, { status: 400 });
  }
  if (!verifyShopifyHmac(params, clientSecret)) {
    return Response.json({ ok: false, error: "توقيع Shopify غير صحيح (hmac)." }, { status: 400 });
  }

  // Exchange the grant code for the permanent offline token.
  let token = "", scope = "";
  try {
    const r = await fetch(`https://${domain}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code: params.code }),
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) {
      const detail = (await r.text()).slice(0, 300);
      return Response.json({ ok: false, error: `token exchange failed (${r.status}): ${detail}` }, { status: 502 });
    }
    const j = (await r.json()) as { access_token?: string; scope?: string };
    token = String(j.access_token ?? "");
    scope = String(j.scope ?? "");
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : "token exchange failed" }, { status: 502 });
  }
  if (!token) return Response.json({ ok: false, error: "ما رجع access_token من Shopify." }, { status: 502 });

  const admin = createAdminClient();
  const { error } = await admin.from("shopify_tokens").upsert(
    { shop: domain, access_token: token, scope, updated_at: new Date().toISOString() },
    { onConflict: "shop" },
  );
  if (error) {
    const hint = /shopify_tokens/.test(error.message) ? " — شغّل supabase/shopify_tokens.sql مرة وحدة." : "";
    return Response.json({ ok: false, error: error.message + hint }, { status: 500 });
  }
  invalidateShopifyTokenCache();

  redirect("/import-export/shopify-sync?connected=1");
}
