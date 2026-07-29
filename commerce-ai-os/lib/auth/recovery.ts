// Pure, framework-free helpers for the prefetch-safe password-recovery flow.
//
// Supabase's default `{{ .ConfirmationURL }}` points at `/auth/v1/verify`, which
// CONSUMES the one-time token on GET — Gmail/Google link scanners fetch it
// within seconds and burn the token before the user clicks. This flow receives
// `token_hash=...&type=recovery` and verifies only after an explicit click.
//
// The token may arrive in either place:
//   - the URL *fragment* (`/auth/recovery#token_hash=...`) — never sent to the
//     server or link scanners (the most prefetch-safe form), or
//   - the *query string* (`/auth/recovery?token_hash=...`) — the form produced
//     by the Supabase email template `{{ .TokenHash }}`.
// The fragment is preferred; the query is a fallback. Either way NOTHING is
// verified on load, so a link-scanner GET cannot burn the token.
//
// Kept dependency-free so it runs under the repo's node:test runner.

export const MIN_RECOVERY_PASSWORD_LENGTH = 12;

/**
 * Parse a `token_hash`/`type` pair from a URL fragment or query string.
 * A leading `#` or `?` is optional.
 */
export function parseRecoveryParams(raw: string | null | undefined): {
  tokenHash: string | null;
  type: string | null;
} {
  if (!raw) return { tokenHash: null, type: null };
  const stripped = raw.startsWith("#") || raw.startsWith("?") ? raw.slice(1) : raw;
  const params = new URLSearchParams(stripped);
  return { tokenHash: params.get("token_hash"), type: params.get("type") };
}

/**
 * Backwards-compatible alias: parse `#token_hash=...&type=recovery`
 * (leading '#' optional). Fragment-oriented callers can keep using this.
 */
export function parseRecoveryHash(hash: string | null | undefined): {
  tokenHash: string | null;
  type: string | null;
} {
  return parseRecoveryParams(hash);
}

/** A usable recovery link must be `type=recovery` with a non-empty token hash. */
export function isValidRecoveryParams(
  type: string | null,
  tokenHash: string | null
): boolean {
  return type === "recovery" && typeof tokenHash === "string" && tokenHash.length > 0;
}

export type RecoveryTokenSource = "fragment" | "query" | "none";

/**
 * Resolve the recovery token from a URL, preferring the prefetch-safe fragment
 * and falling back to the query string. Reports which source matched so the
 * caller can clear the right part of the URL.
 *
 * Only a `type=recovery` link with a non-empty `token_hash` is accepted; an
 * invalid fragment does not shadow a valid query (and vice versa).
 */
export function resolveRecoveryToken(
  hash: string | null | undefined,
  search: string | null | undefined
): { tokenHash: string | null; type: string | null; source: RecoveryTokenSource } {
  const fromHash = parseRecoveryParams(hash);
  if (isValidRecoveryParams(fromHash.type, fromHash.tokenHash)) {
    return { tokenHash: fromHash.tokenHash, type: fromHash.type, source: "fragment" };
  }
  const fromQuery = parseRecoveryParams(search);
  if (isValidRecoveryParams(fromQuery.type, fromQuery.tokenHash)) {
    return { tokenHash: fromQuery.tokenHash, type: fromQuery.type, source: "query" };
  }
  return { tokenHash: null, type: null, source: "none" };
}

/** Validate a new password: length >= 12 and both entries match. */
export function validateNewPassword(
  pw: string,
  confirm: string
): { ok: boolean; error?: string } {
  if (pw.length < MIN_RECOVERY_PASSWORD_LENGTH) {
    return {
      ok: false,
      error: `Password must be at least ${MIN_RECOVERY_PASSWORD_LENGTH} characters.`,
    };
  }
  if (pw !== confirm) {
    return { ok: false, error: "Passwords do not match." };
  }
  return { ok: true };
}

/** Safe, generic messages — never surface raw Supabase errors or tokens. */
export const RECOVERY_ERRORS = {
  invalidLink: "This password reset link is invalid or has expired.",
  verifyFailed: "Could not verify the password reset link.",
  updateFailed: "Could not update the password.",
} as const;

export const LOGIN_ERRORS = {
  signInFailed: "Email or password is incorrect.",
  generic: "Something went wrong. Please try again.",
  resetRequestFailed:
    "Could not send the password reset email. Please try again later.",
} as const;

/** Generic (non-enumerating) confirmation shown after requesting a reset. */
export const RESET_REQUEST_SENT =
  "If an account exists for that email, a password reset link has been sent.";

export type ResetRequestOutcome =
  | { status: "sent"; message: string }
  | { status: "failed"; message: string };

/**
 * Orchestrates a password-reset request in a prefetch-safe, non-enumerating way.
 *
 * - Trims the email before handing it to `sendReset`.
 * - Inspects the `{ error }` the provider returns: a truthy error (rate limit,
 *   misconfiguration, etc.) yields the generic FAILURE message — never the raw
 *   provider text — so the success notice is NOT shown on failure.
 * - A thrown exception / network failure is caught and mapped to the same
 *   generic failure message.
 * - Success (and only success) returns the generic, non-enumerating SENT
 *   message, identical whether or not an account exists for that email.
 *
 * Kept pure and dependency-free (the Supabase call is injected) so it runs
 * under the repo's node:test runner.
 */
export async function requestPasswordReset(
  email: string,
  sendReset: (normalizedEmail: string) => Promise<{ error: unknown }>
): Promise<ResetRequestOutcome> {
  const normalizedEmail = email.trim();
  try {
    const { error } = await sendReset(normalizedEmail);
    if (error) {
      return { status: "failed", message: LOGIN_ERRORS.resetRequestFailed };
    }
    return { status: "sent", message: RESET_REQUEST_SENT };
  } catch {
    return { status: "failed", message: LOGIN_ERRORS.resetRequestFailed };
  }
}
