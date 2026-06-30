import { cookies } from "next/headers";
import { verifyStaff, STAFF_COOKIE } from "@/lib/staff/session";
import StaffClient from "./StaffClient";
import { staffToday } from "./actions";

export const dynamic = "force-dynamic";

// Public, PIN-gated stock IN/OUT page for store employees. Lives OUTSIDE the
// (app) route group so it never shows the admin shell (no prices, no Malak).
export default async function StaffPage() {
  let who: { name: string } | null = null;
  try {
    who = verifyStaff((await cookies()).get(STAFF_COOKIE)?.value);
  } catch {
    who = null; // signing secret not set → treat as logged out
  }
  const today = who ? (await staffToday()).rows : [];
  return <StaffClient initialName={who?.name ?? null} initialToday={today} />;
}
