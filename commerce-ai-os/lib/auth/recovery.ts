// Pure, framework-free helpers for the prefetch-safe password-recovery flow.
//
// Supabase's default `{{ .ConfirmationURL }}` points at `/auth/v1/verify`, which
// CONSUMES the one-time token on GET — Gmail/Google link scanners fetch it
// within seconds and burn the token before the user clicks. This flow instead
// receives `#token_hash=...&type=recovery` in the URL *fragment* (never sent to
// the server or scanners) and verifies only after an explicit click.
//
// Kept dependency-free so it runs under the repo's node:test runner.

export const MIN_RECOVERY_PASSWORD_LENGTH = 12;

/** Parse `#token_hash=...&type=recovery` (leading '#' optional). */
export function parseRecoveryHash(hash: string | null | undefined): {
  tokenHash: string | null;
  type: string | null;
} {
  if (!hash) return { tokenHash: null, type: null };
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const params = new URLSearchParams(raw);
  return { tokenHash: params.get("token_hash"), type: params.get("type") };
}

/** A usable recovery link must be `type=recovery` with a non-empty token hash. */
export function isValidRecoveryParams(
  type: string | null,
  tokenHash: string | null
): boolean {
  return type === "recovery" && typeof tokenHash === "string" && tokenHash.length > 0;
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
} as const;

/** Generic (non-enumerating) confirmation shown after requesting a reset. */
export const RESET_REQUEST_SENT =
  "If an account exists for that email, a password reset link has been sent.";
