// Pure owner-authorization decision — deliberately free of `@/` and
// `server-only` imports so it is directly unit-testable (node:test cannot
// resolve those). `authz.ts` wraps this with the Supabase session lookup; the
// decision logic itself (who is allowed, which status, what message) lives here
// with no I/O and no secrets in its result.

export type OwnerDecision =
  | { ok: true; email: string }
  | { ok: false; status: 401 | 403; error: string };

/**
 * Safe, constant denial for a non-owner attempting an external publish/
 * messaging action. Deliberately generic — it never reveals the owner email or
 * the writer allow-list, and it reads identically whether the caller is signed
 * out, a staff member, or an unlisted signed-in user.
 */
export const OWNER_ONLY_DENIED = "هذا الإجراء متاح للمالك فقط.";

/**
 * Decide owner access from an already-resolved Supabase session. `hasUser`
 * distinguishes "no session at all" (→ 401) from "signed in but not the owner"
 * (→ 403); `sessionEmail` is the email read from that session (null/empty when
 * unavailable); `ownerEmail` is the configured owner. The email comparison is
 * case-insensitive. No network, no logging, no secret ever appears in the
 * returned value.
 */
export function decideOwner(
  hasUser: boolean,
  sessionEmail: string | null | undefined,
  ownerEmail: string,
): OwnerDecision {
  if (!hasUser) return { ok: false, status: 401, error: OWNER_ONLY_DENIED };
  const email = (sessionEmail ?? "").toLowerCase();
  if (!email || email !== ownerEmail.toLowerCase()) {
    return { ok: false, status: 403, error: OWNER_ONLY_DENIED };
  }
  return { ok: true, email };
}
