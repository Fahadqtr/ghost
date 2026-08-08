// TickTick OAuth tests (Phase UI.7.5 callback setup). PURE — an injected fetch,
// no network, no secrets. Run:
// node --conditions=react-server --experimental-strip-types --test lib/integrations/ticktick/oauth.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildAuthorizeUrl, parseCallbackParams, validateState, exchangeCodeForToken, oauthMessage,
  TICKTICK_AUTHORIZE_URL, TICKTICK_TOKEN_URL, TICKTICK_OAUTH_SCOPE,
} from "./oauth.ts";

// ── authorize URL ────────────────────────────────────────────────────────────

test("buildAuthorizeUrl includes public params + scope + state, and NO secret", () => {
  const u = new URL(buildAuthorizeUrl({ clientId: "CID", redirectUri: "https://app.malikasuniverse.com/api/integrations/ticktick/callback", state: "st8" }));
  assert.ok(u.href.startsWith(TICKTICK_AUTHORIZE_URL));
  assert.equal(u.searchParams.get("client_id"), "CID");
  assert.equal(u.searchParams.get("redirect_uri"), "https://app.malikasuniverse.com/api/integrations/ticktick/callback");
  assert.equal(u.searchParams.get("response_type"), "code");
  assert.equal(u.searchParams.get("scope"), TICKTICK_OAUTH_SCOPE);
  assert.equal(u.searchParams.get("scope"), "tasks:read tasks:write");
  assert.equal(u.searchParams.get("state"), "st8");
  assert.ok(!u.href.toLowerCase().includes("secret"));
});

// ── callback params + state (CSRF) ───────────────────────────────────────────

test("parseCallbackParams extracts trimmed code/state/error", () => {
  const p = parseCallbackParams(new URLSearchParams("code=abc&state=xyz"));
  assert.deepEqual(p, { code: "abc", state: "xyz", error: "" });
  const e = parseCallbackParams(new URLSearchParams("error=access_denied"));
  assert.equal(e.error, "access_denied");
  assert.equal(e.code, "");
});

test("validateState requires a non-empty cookie equal to the callback state", () => {
  assert.equal(validateState("s1", "s1"), true);
  assert.equal(validateState("s1", "s2"), false);
  assert.equal(validateState("", ""), false, "empty state never validates");
  assert.equal(validateState(null, ""), false);
  assert.equal(validateState(undefined, "s1"), false);
});

// ── token exchange (server-side; token never returned) ───────────────────────

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
const GOOD = { code: "authcode", clientId: "CID", clientSecret: "SECRET", redirectUri: "https://x/cb" };

test("a successful exchange returns ok WITHOUT the token (never exposed)", async () => {
  const fetchImpl = (async () => jsonResponse({ access_token: "super-secret-token-123", token_type: "bearer" })) as unknown as typeof fetch;
  const r = await exchangeCodeForToken(GOOD, fetchImpl);
  assert.deepEqual(r, { ok: true });
  assert.ok(!("code" in r));
  assert.ok(!JSON.stringify(r).includes("super-secret-token-123"), "token must never appear in the result");
});

test("missing code / missing config short-circuit before any network call", async () => {
  let called = false;
  const spy = (async () => { called = true; return jsonResponse({}); }) as unknown as typeof fetch;
  assert.deepEqual(await exchangeCodeForToken({ ...GOOD, code: "" }, spy), { ok: false, code: "missing_code" });
  assert.deepEqual(await exchangeCodeForToken({ ...GOOD, clientSecret: "" }, spy), { ok: false, code: "not_configured" });
  assert.equal(called, false, "no network attempted when inputs are invalid");
});

test("a non-OK HTTP status → exchange_failed (no raw body)", async () => {
  const fetchImpl = (async () => new Response("Unauthorized: bad client_secret", { status: 401 })) as unknown as typeof fetch;
  const r = await exchangeCodeForToken(GOOD, fetchImpl);
  assert.deepEqual(r, { ok: false, code: "exchange_failed" });
  assert.ok(!JSON.stringify(r).toLowerCase().includes("secret"));
});

test("a response without access_token → bad_response", async () => {
  const fetchImpl = (async () => jsonResponse({ error: "invalid_grant" })) as unknown as typeof fetch;
  assert.deepEqual(await exchangeCodeForToken(GOOD, fetchImpl), { ok: false, code: "bad_response" });
});

test("unparseable JSON → bad_response", async () => {
  const fetchImpl = (async () => new Response("<html>oops</html>", { status: 200 })) as unknown as typeof fetch;
  assert.deepEqual(await exchangeCodeForToken(GOOD, fetchImpl), { ok: false, code: "bad_response" });
});

test("a timeout (AbortError) → timeout; a network error → exchange_failed", async () => {
  const abort = (async () => { const e = new Error("t"); e.name = "AbortError"; throw e; }) as unknown as typeof fetch;
  const net = (async () => { const e = new Error("n"); e.name = "TypeError"; throw e; }) as unknown as typeof fetch;
  assert.deepEqual(await exchangeCodeForToken(GOOD, abort), { ok: false, code: "timeout" });
  assert.deepEqual(await exchangeCodeForToken(GOOD, net), { ok: false, code: "exchange_failed" });
});

test("exchange POSTs to the official token endpoint", async () => {
  let url = "";
  const fetchImpl = (async (u: string) => { url = u; return jsonResponse({ access_token: "t" }); }) as unknown as typeof fetch;
  await exchangeCodeForToken(GOOD, fetchImpl);
  assert.equal(url, TICKTICK_TOKEN_URL);
});

// ── fixed messages ───────────────────────────────────────────────────────────

test("success message is the exact fixed Arabic string; no code leaks a raw error", () => {
  assert.equal(oauthMessage("success"), "تم ربط TickTick بنجاح.");
  for (const c of ["provider_error", "missing_code", "invalid_state", "not_configured", "exchange_failed", "timeout", "bad_response"] as const) {
    assert.equal(typeof oauthMessage(c), "string");
    assert.ok(oauthMessage(c).length > 0);
  }
});

// ── route source-safety scans ────────────────────────────────────────────────

const CALLBACK = readFileSync(new URL("../../../app/api/integrations/ticktick/callback/route.ts", import.meta.url), "utf8");
const AUTHORIZE = readFileSync(new URL("../../../app/api/integrations/ticktick/authorize/route.ts", import.meta.url), "utf8");

test("callback route: owner-gated, fixed Arabic success, NO token/secret/DB in the handler", () => {
  assert.ok(CALLBACK.includes("requireOwner"), "callback must be owner-gated");
  assert.ok(CALLBACK.includes("تم ربط TickTick بنجاح") || CALLBACK.includes('oauthMessage("success")'), "shows the fixed success message");
  assert.ok(!CALLBACK.includes("access_token"), "the token is never referenced in the route/response");
  // NOTE: jar.delete(stateCookie) is a legitimate cookie clear — the DB-write
  // ban below covers .insert(/.rpc(/admin/service-role, not cookie deletion.
  for (const banned of ["createAdminClient", "service_role", "@/lib/supabase", ".insert(", ".rpc(", "NEXT_PUBLIC"]) {
    assert.ok(!CALLBACK.includes(banned), `callback must not contain ${banned}`);
  }
});

test("authorize route: owner-gated, httpOnly state cookie, redirect, no secret in response", () => {
  assert.ok(AUTHORIZE.includes("requireOwner"), "authorize must be owner-gated");
  assert.ok(AUTHORIZE.includes("httpOnly: true"), "state cookie must be httpOnly");
  assert.ok(AUTHORIZE.includes("redirect("), "authorize redirects to the provider");
  assert.ok(!AUTHORIZE.includes("access_token"));
  assert.ok(!AUTHORIZE.includes("TICKTICK_CLIENT_SECRET"), "client secret is never used on the authorize step");
  for (const banned of ["createAdminClient", "service_role", "@/lib/supabase", ".insert(", ".update("]) {
    assert.ok(!AUTHORIZE.includes(banned), `authorize must not contain ${banned}`);
  }
});
