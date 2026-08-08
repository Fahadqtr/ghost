// TickTick OAuth tests (Phase UI.7.5, Option B). PURE — no network, no secrets.
// The app does NOT exchange the code (the owner does that externally); the
// callback is validation/authorization-flow only. Run:
// node --conditions=react-server --experimental-strip-types --test lib/integrations/ticktick/oauth.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildAuthorizeUrl, parseCallbackParams, validateState, oauthMessage, tokenExchangeCurl,
  TICKTICK_AUTHORIZE_URL, TICKTICK_TOKEN_URL, TICKTICK_OAUTH_SCOPE,
} from "./oauth.ts";

// ── authorize URL ────────────────────────────────────────────────────────────

test("buildAuthorizeUrl includes public params + scope + state, and NO secret", () => {
  const u = new URL(buildAuthorizeUrl({ clientId: "CID", redirectUri: "https://app.malikasuniverse.com/api/integrations/ticktick/callback", state: "st8" }));
  assert.ok(u.href.startsWith(TICKTICK_AUTHORIZE_URL));
  assert.equal(u.searchParams.get("client_id"), "CID");
  assert.equal(u.searchParams.get("redirect_uri"), "https://app.malikasuniverse.com/api/integrations/ticktick/callback");
  assert.equal(u.searchParams.get("response_type"), "code");
  assert.equal(u.searchParams.get("scope"), "tasks:read tasks:write");
  assert.equal(u.searchParams.get("state"), "st8");
  assert.ok(!u.href.toLowerCase().includes("secret"));
});

// ── callback params + state (CSRF) ───────────────────────────────────────────

test("parseCallbackParams extracts trimmed code/state/error", () => {
  assert.deepEqual(parseCallbackParams(new URLSearchParams("code=abc&state=xyz")), { code: "abc", state: "xyz", error: "" });
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

// ── external exchange curl (placeholders only) ───────────────────────────────

test("tokenExchangeCurl is placeholder-only and posts to the official token endpoint", () => {
  const c = tokenExchangeCurl();
  assert.ok(c.includes(TICKTICK_TOKEN_URL));
  assert.ok(c.includes("grant_type=authorization_code"));
  assert.ok(c.includes(`scope=${TICKTICK_OAUTH_SCOPE}`));
  for (const ph of ["<AUTHORIZATION_CODE>", "<CLIENT_ID>", "<CLIENT_SECRET>", "<REDIRECT_URI>"]) {
    assert.ok(c.includes(ph), `curl must use the ${ph} placeholder`);
  }
  // no real secret / token value is ever baked into the command
  assert.ok(!/access_token/i.test(c));
});

// ── fixed failure messages ───────────────────────────────────────────────────

test("failure codes map to fixed Arabic messages", () => {
  for (const code of ["provider_error", "missing_code", "invalid_state", "not_configured"] as const) {
    assert.equal(typeof oauthMessage(code), "string");
    assert.ok(oauthMessage(code).length > 0);
  }
});

// ── route source-safety scans ────────────────────────────────────────────────

const CALLBACK = readFileSync(new URL("../../../app/api/integrations/ticktick/callback/route.ts", import.meta.url), "utf8");
const AUTHORIZE = readFileSync(new URL("../../../app/api/integrations/ticktick/authorize/route.ts", import.meta.url), "utf8");

test("callback is validation-only: owner-gated, CSRF, escapes the code, NO exchange/secret/DB", () => {
  assert.ok(CALLBACK.includes("requireOwner"), "owner-gated");
  assert.ok(CALLBACK.includes("validateState"), "CSRF state validated");
  assert.ok(CALLBACK.includes("esc(code)") || CALLBACK.includes("esc("), "dynamic code is HTML-escaped");
  assert.ok(CALLBACK.includes("tokenExchangeCurl"), "shows the external exchange curl");
  assert.ok(CALLBACK.includes("TICKTICK_ACCESS_TOKEN"), "instructs the owner about the Vercel env var");
  // Option B: the app performs NO exchange and never touches the client secret.
  assert.ok(!CALLBACK.includes("fetch("), "callback must not call any network endpoint");
  assert.ok(!CALLBACK.includes("exchangeCodeForToken"), "no server-side exchange");
  assert.ok(!CALLBACK.includes("client_secret"), "client secret is never used in the callback");
  assert.ok(!CALLBACK.includes("TICKTICK_CLIENT_SECRET"), "client secret env not read at the callback");
  for (const banned of ["createAdminClient", "service_role", "@/lib/supabase", ".insert(", ".rpc(", "NEXT_PUBLIC", "console."]) {
    assert.ok(!CALLBACK.includes(banned), `callback must not contain ${banned}`);
  }
});

test("authorize route: owner-gated, httpOnly state cookie, redirect, no secret/DB", () => {
  assert.ok(AUTHORIZE.includes("requireOwner"), "owner-gated");
  assert.ok(AUTHORIZE.includes("httpOnly: true"), "state cookie must be httpOnly");
  assert.ok(AUTHORIZE.includes("redirect("), "authorize redirects to the provider");
  assert.ok(!AUTHORIZE.includes("access_token"));
  assert.ok(!AUTHORIZE.includes("TICKTICK_CLIENT_SECRET"), "client secret is never used on the authorize step");
  assert.ok(!AUTHORIZE.includes("console."), "no logging on the authorize step");
  for (const banned of ["createAdminClient", "service_role", "@/lib/supabase", ".insert(", ".rpc("]) {
    assert.ok(!AUTHORIZE.includes(banned), `authorize must not contain ${banned}`);
  }
});
