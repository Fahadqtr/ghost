// Pure Malak WRITE authorization decision — deliberately free of `@/` and
// `server-only` imports so it is directly unit-testable (node:test cannot
// resolve those). This is the exact mirror of owner-check.ts: `authz.ts` wraps
// it with the Supabase session lookup and the MALAK_WRITER_EMAILS env read,
// while the decision itself (who is allowed, which status, what message) lives
// here with no I/O and no secret in its result.
//
// D-4A2 — extracted, not redesigned. The allow-list, the case-insensitive
// comparison, both denial strings and both status codes are carried over
// verbatim from the previous inline implementation, so no caller's behaviour
// changes; the logic simply became provable.

export type WriterDecision =
  | { ok: true; email: string }
  | { ok: false; status: 401 | 403; error: string };

/** No session at all. */
export const WRITER_NOT_SIGNED_IN = "غير مسجّل الدخول.";

/**
 * Signed in, but not on the write allow-list. Constant and generic: it never
 * reveals the owner address or who else is on the list, and reads identically
 * for a staff member and for an unlisted signed-in account.
 */
export const WRITER_READ_ONLY_DENIED = "ما عندك صلاحية التعديل عبر ملاك — للقراءة فقط.";

/**
 * The effective write allow-list: always the owner, plus any comma-separated
 * extras. The owner is included unconditionally so a missing or malformed env
 * var can never lock writes out — it can only fail to widen them.
 */
export function writerAllowList(
  ownerEmail: string,
  extraEmails: string | null | undefined,
): Set<string> {
  const extra = String(extraEmails ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return new Set([ownerEmail.toLowerCase(), ...extra]);
}

/**
 * Decide write access from an already-resolved Supabase session. `hasUser`
 * distinguishes "no session at all" (→ 401) from "signed in but not a writer"
 * (→ 403). Fails closed on a blank/missing email. No network, no logging, no
 * secret in the returned value.
 */
export function decideWriter(
  hasUser: boolean,
  sessionEmail: string | null | undefined,
  ownerEmail: string,
  extraEmails: string | null | undefined,
): WriterDecision {
  if (!hasUser) return { ok: false, status: 401, error: WRITER_NOT_SIGNED_IN };
  const email = (sessionEmail ?? "").toLowerCase();
  if (!email || !writerAllowList(ownerEmail, extraEmails).has(email)) {
    return { ok: false, status: 403, error: WRITER_READ_ONLY_DENIED };
  }
  return { ok: true, email };
}
