import "server-only";
import { requireOwner } from "@/lib/malak/authz";
import { currentStaff } from "@/lib/staff/current";
import { decideCrmAccess, type CrmAccess } from "@/lib/crm/access-check";

// D-2 — the CRM customer-service read boundary.
//
// OWNER DECISION (STEP SYSTEM ACCESS 10):
//   • staff MAY READ the customer/order information needed for daily operations
//     and customer service — and nothing more (see lib/crm/staff-view.ts)
//   • staff MAY NOT modify or delete customers
//   • an ordinary Supabase authenticated user gets NOTHING here merely because a
//     session exists — that is the hole this closes
//
// Two independent credentials are accepted, resolved in this order:
//   1. the OWNER's Supabase session (requireOwner → decideOwner: hardcoded owner
//      constant, server-side getUser(), fails closed)
//   2. a validated STAFF session (currentStaff → HMAC-SHA256 cookie compared
//      with timingSafeEqual, 12h expiry, permissions and `active` re-read live
//      from staff_members so a deactivated employee is rejected mid-shift)
//
// An ordinary Supabase session satisfies NEITHER — it is not the owner, and it
// is not the staff cookie. The decision itself is the pure, unit-tested
// decideCrmAccess(); this wrapper only supplies the two lookups.

export type { CrmViewer, CrmAccess } from "@/lib/crm/access-check";
export { CRM_ACCESS_DENIED } from "@/lib/crm/access-check";

export async function requireCrmReader(): Promise<CrmAccess> {
  const owner = await requireOwner();
  if (owner.ok) return decideCrmAccess(true, null);
  return decideCrmAccess(false, await currentStaff());
}
