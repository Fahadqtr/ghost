import "server-only";
import { cookies } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import { verifyStaff, STAFF_COOKIE } from "./session";
import { parsePermissions, DEFAULT_PERMISSIONS, type StaffPermission } from "./permissions";

// D-2 — the canonical "who is the logged-in employee" resolver.
//
// Moved here verbatim from app/staff/actions.ts so a second consumer (CRM
// customer-service reads) can share the SAME gate instead of duplicating a
// security check. app/staff/actions.ts now imports it; the logic, the DB
// re-read and the fallback are unchanged.
//
// It could not simply be exported from app/staff/actions.ts: that file is
// "use server", so every export there becomes a publicly invokable server
// action endpoint. A gate must not be one.
//
// Why this is a real authorization boundary and not a client-supplied claim:
//   • the cookie is an HMAC-SHA256 token over the payload, compared with
//     crypto.timingSafeEqual — it cannot be forged without the server secret
//   • it expires after one shift (12h), checked against the signed timestamp
//   • permissions and `active` are re-read LIVE from staff_members by id, so a
//     revoked permission or a deactivated employee takes effect immediately
//     rather than lingering for the life of the token
//   • it is a different credential from a Supabase session: holding one grants
//     nothing here, which is what keeps "ordinary authenticated user" out

export type CurrentStaff = { name: string; id: string | null; perms: StaffPermission[] };

function adminClient(): any | null {
  try {
    return createAdminClient();
  } catch {
    return null;
  }
}

/**
 * Resolve the logged-in employee AND their live permissions, or null when there
 * is no valid staff session. Perms are re-read fresh from the DB (by id) so an
 * admin's change takes effect without re-login; the signed token's snapshot is
 * the fallback when the DB can't be reached.
 */
export async function currentStaff(): Promise<CurrentStaff | null> {
  const c = await cookies();
  const s = verifyStaff(c.get(STAFF_COOKIE)?.value);
  if (!s) return null;
  let perms = s.perms ? parsePermissions(s.perms) : [...DEFAULT_PERMISSIONS];
  if (s.id) {
    const admin = adminClient();
    if (admin) {
      try {
        const { data } = await admin.from("staff_members").select("permissions, active").eq("id", s.id).limit(1);
        const row = (data ?? [])[0];
        if (row) {
          if (row.active === false) return null; // deactivated mid-shift
          perms = parsePermissions(row.permissions);
        }
      } catch { /* keep token snapshot */ }
    }
  }
  return { name: s.name, id: s.id ?? null, perms };
}
