// Pure CRM access decision — deliberately free of `@/` and `server-only`
// imports so it is directly unit-testable, mirroring lib/malak/owner-check.ts
// and lib/malak/writer-check.ts. lib/auth/crmAccess.ts wraps this with the two
// credential lookups; the decision itself lives here with no I/O.

export type CrmViewer =
  | { kind: "owner" }
  | { kind: "staff"; name: string; id: string | null };

export type CrmAccess =
  | { viewer: CrmViewer; error?: undefined }
  | { viewer?: undefined; error: string };

/**
 * Constant denial. Generic on purpose: it never says which credential was
 * missing, never names the owner, and reads identically to a signed-out caller,
 * an ordinary Supabase user, and an expired staff session.
 */
export const CRM_ACCESS_DENIED = "هذا الإجراء غير متاح لحسابك.";

/**
 * Decide CRM read access from two ALREADY-RESOLVED credentials.
 *
 * `ownerIsOk` is the result of the owner gate (a verified Supabase session whose
 * email is the owner). `staff` is the result of the validated staff-session
 * lookup, or null when there is no valid one.
 *
 * The four cases the owner's policy distinguishes:
 *   owner session              → allowed as owner (full fields)
 *   valid staff session        → allowed as staff (minimized fields)
 *   authenticated non-owner    → ownerIsOk false AND staff null → DENIED
 *   unauthenticated            → ownerIsOk false AND staff null → DENIED
 *
 * The last two collapse deliberately: holding an ordinary Supabase session is
 * worth exactly as much here as holding nothing, which is the hole D-2 closes.
 * Fails closed — anything that is not one of the two positive credentials denies.
 */
export function decideCrmAccess(
  ownerIsOk: boolean,
  staff: { name: string; id: string | null } | null | undefined,
): CrmAccess {
  if (ownerIsOk) return { viewer: { kind: "owner" } };
  if (staff && typeof staff.name === "string" && staff.name) {
    return { viewer: { kind: "staff", name: staff.name, id: staff.id ?? null } };
  }
  return { error: CRM_ACCESS_DENIED };
}

/** True when the resolved viewer must receive the minimized field set. */
export function isStaffViewer(viewer: CrmViewer | undefined): boolean {
  return viewer?.kind === "staff";
}
