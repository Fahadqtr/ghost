// Malikas V2 — TickTick OAuth logic (Phase UI.7.5 callback setup). PURE +
// self-contained (no DB, no framework, no secrets baked in) so it is unit-
// testable with an injected fetch. The token exchange happens server-side and
// the access token is DELIBERATELY never returned to any caller — so it can
// never reach a response body, a cookie, a log line, or the database.

export const TICKTICK_AUTHORIZE_URL = "https://ticktick.com/oauth/authorize";
export const TICKTICK_TOKEN_URL = "https://ticktick.com/oauth/token";
export const TICKTICK_OAUTH_SCOPE = "tasks:read tasks:write";

export type OAuthMessageCode =
  | "success"
  | "provider_error"
  | "missing_code"
  | "invalid_state"
  | "not_configured"
  | "exchange_failed"
  | "timeout"
  | "bad_response";

// Fixed Arabic messages — a raw provider error / body / URL / token is NEVER
// surfaced through these.
const MESSAGES: Record<OAuthMessageCode, string> = {
  success: "تم ربط TickTick بنجاح.",
  provider_error: "تعذّر ربط TickTick — لم يُمنح التفويض.",
  missing_code: "رمز التفويض مفقود.",
  invalid_state: "فشل التحقق من الطلب — أعد بدء عملية الربط.",
  not_configured: "TickTick غير مهيأ.",
  exchange_failed: "تعذّر إكمال ربط TickTick.",
  timeout: "انتهت مهلة الاتصال بـ TickTick.",
  bad_response: "استجابة غير متوقعة من TickTick.",
};

export function oauthMessage(code: OAuthMessageCode): string {
  return Object.hasOwn(MESSAGES, code) ? MESSAGES[code] : MESSAGES.exchange_failed;
}

/** Build the official TickTick authorization URL (no secret is included — only
 *  the public client_id, redirect_uri, scope and CSRF state). */
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

export interface ExchangeInput {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/** ok:true carries NO token — success only. Failure carries a safe code. */
export type ExchangeResult = { ok: true } | { ok: false; code: OAuthMessageCode };

/**
 * Exchange an authorization code for a token, SERVER-SIDE. Timeout-bounded. The
 * access token is validated then discarded — it is never returned, logged, or
 * otherwise exposed. `fetchImpl` is injected in tests (no real network).
 */
export async function exchangeCodeForToken(
  input: ExchangeInput,
  fetchImpl: typeof fetch = fetch,
): Promise<ExchangeResult> {
  if (!input.code) return { ok: false, code: "missing_code" };
  if (!input.clientId || !input.clientSecret || !input.redirectUri) return { ok: false, code: "not_configured" };

  let res: Response;
  try {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      client_id: input.clientId,
      client_secret: input.clientSecret,
      redirect_uri: input.redirectUri,
      scope: TICKTICK_OAUTH_SCOPE,
    });
    res = await fetchImpl(TICKTICK_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: body.toString(),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    const name = (e as { name?: string } | null)?.name;
    if (name === "AbortError" || name === "TimeoutError") return { ok: false, code: "timeout" };
    return { ok: false, code: "exchange_failed" };
  }

  if (!res.ok) return { ok: false, code: "exchange_failed" };
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    return { ok: false, code: "bad_response" };
  }
  const token = (json as { access_token?: unknown } | null)?.access_token;
  if (typeof token !== "string" || token.trim() === "") return { ok: false, code: "bad_response" };

  // SUCCESS. The token is intentionally NOT returned — obtaining it for the
  // Vercel env is a separate, owner-driven step (see the PR's OWNER ACTION).
  return { ok: true };
}
