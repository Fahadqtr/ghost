import type { Metadata, Viewport } from "next";
import { getLocale } from "@/lib/i18n-server";
import StaffClient from "./StaffClient";
import StaffInstallPrompt from "./StaffInstallPrompt";
import { staffToday, staffMe } from "./actions";
import { DEFAULT_PERMISSIONS, type StaffPermission } from "@/lib/staff/permissions";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // AI image edit can take 20–40s

// Make /staff its own installable PWA (opens straight to the employee page,
// standalone, with a distinct name/icon) — separate from the admin app.
export const metadata: Metadata = {
  manifest: "/staff.webmanifest",
  appleWebApp: { capable: true, title: "موظفو ماليكا", statusBarStyle: "default" },
};
export const viewport: Viewport = { themeColor: "#7c3aed" };

// Public, PIN-gated employee page. Lives OUTSIDE the (app) route group so it
// never shows the admin shell. What each employee sees is driven by the
// permissions the owner granted them on /team.
export default async function StaffPage() {
  let name: string | null = null;
  let perms: StaffPermission[] = [...DEFAULT_PERMISSIONS];
  let today: Awaited<ReturnType<typeof staffToday>>["rows"] = [];
  try {
    const me = await staffMe();
    if (me) {
      name = me.name;
      perms = me.perms;
      today = (await staffToday()).rows;
    }
  } catch {
    // signing secret / service-role not set on this deploy → render the gate
    // (or an empty desk) instead of crashing the page.
    today = [];
  }
  const locale = await getLocale();
  return (
    <>
      <StaffClient initialName={name} initialPerms={perms} initialToday={today} locale={locale} />
      <StaffInstallPrompt locale={locale} />
    </>
  );
}
