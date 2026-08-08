// Malikas V2 — TickTick OAuth logic (Phase UI.7.5, Option B). PURE + self-
// contained (no DB, no framework, no secrets baked in), unit-testable.
//
// Option B — the OWNER performs the code→token exchange EXTERNALLY (curl); the
// app's callback is validation/authorization-flow ONLY. So there is no server-
// side token exchange here: the app never touches client_secret at the callback,
// never receives/handles an access token, and never logs the code or any secret.
// The callback (owner-only) shows the short-lived authorization code + a
// placeholder curl the owner runs off-app, then the owner pastes the resulting
// token into the Vercel env manually.

export const TICKTICK_AUTHORIZE_URL = "https://ticktick.com/oauth/authorize";
export const TICKTICK_TOKEN_URL = "https://ticktick.com/oauth/token";
export const TICKTICK_OAUTH_SCOPE = "tasks:read tasks:write";

export type OAuthMessageCode = "provider_error" | "missing_code" | "invalid_state" | "not_configured";

// Fixed Arabic failure messages — a raw provider error / body is NEVER surfaced.
const MESSAGES: Record<OAuthMessageCode, string> = {
  provider_error: "تعذّر ربط TickTick — لم يُمنح التفويض.",
  missing_code: "رمز التفويض مفقود.",
  invalid_state: "فشل التحقق من الطلب — أعد بدء عملية الربط.",
  not_configured: "TickTick غير مهيأ.",
};

export function oauthMessage(code: OAuthMessageCode): string {
  return Object.hasOwn(MESSAGES, code) ? MESSAGES[code] : MESSAGES.provider_error;
}

/** Build the official TickTick authorization URL — public params only (client_id,
 *  redirect_uri, scope, CSRF state); no secret is ever included. */
export function buildAuthorizeUrl(input: { clientId: string; redirectUri: string; state: string }): string {
  const p = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: TICKTICK_OAUTH_SCOPE,
    state: input.state,
  });
  return `${TICKTICK_AUTHORIZE_URL}?${p.toString()}`;
}

export interface CallbackParams {
  code: string;
  state: string;
  error: string;
}

/** Extract the callback params (trimmed). */
export function parseCallbackParams(sp: URLSearchParams): CallbackParams {
  const g = (k: string) => (sp.get(k) ?? "").trim();
  return { code: g("code"), state: g("state"), error: g("error") };
}

/** CSRF check: the cookie state must be present AND equal the callback's state. */
export function validateState(cookieState: string | null | undefined, paramState: string): boolean {
  return typeof cookieState === "string" && cookieState.length > 0 && cookieState === paramState;
}

/**
 * The exact, copy-ready curl the OWNER runs EXTERNALLY (off-app) to exchange the
 * authorization code for a token. PLACEHOLDERS ONLY — no real client id/secret/
 * code/redirect is ever baked in, so this string is safe to render or commit.
 */
export function tokenExchangeCurl(): string {
  return [
    `curl -sS -X POST '${TICKTICK_TOKEN_URL}' \\`,
    `  -H 'Content-Type: application/x-www-form-urlencoded' \\`,
    `  --data-urlencode 'grant_type=authorization_code' \\`,
    `  --data-urlencode 'code=<AUTHORIZATION_CODE>' \\`,
    `  --data-urlencode 'client_id=<CLIENT_ID>' \\`,
    `  --data-urlencode 'client_secret=<CLIENT_SECRET>' \\`,
    `  --data-urlencode 'redirect_uri=<REDIRECT_URI>' \\`,
    `  --data-urlencode 'scope=${TICKTICK_OAUTH_SCOPE}'`,
  ].join("\n");
}
