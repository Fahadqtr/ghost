import { cookies } from "next/headers";
import { verifyStaff, STAFF_COOKIE } from "@/lib/staff/session";
import StaffClient from "./StaffClient";
import { staffToday } from "./actions";

export const dynamic = "force-dynamic";

// Public, PIN-gated stock IN/OUT page for store employees. Lives OUTSIDE the
// (app) route group so it never shows the admin shell (no prices, no Malak).
export default async function StaffPage() {
  let who: { name: string } | null = null;
  let today: Awaited<ReturnType<typeof staffToday>>["rows"] = [];
  try {
    who = verifyStaff((await cookies()).get(STAFF_COOKIE)?.value);
    if (who) today = (await staffToday()).rows;
  } catch {
    // signing secret / service-role not set on this deploy → render the gate
    // (or an empty desk) instead of crashing the page.
    who = who ?? null;
    today = [];
  }
  return <StaffClient initialName={who?.name ?? null} initialToday={today} />;
}
