import { redirect } from "next/navigation";
import AppShell from "@/components/AppShell";
import StaleDeploymentBanner from "@/components/StaleDeploymentBanner";
import { createClient } from "@/lib/supabase/server";
import { getLocale } from "@/lib/i18n-server";

// Authenticated app shell: responsive sidebar/drawer + topbar.
// Middleware already gates routes; this is a belt-and-suspenders guard that also
// gives us the current user's email for the Topbar.
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const locale = await getLocale();

  return (
    <AppShell userEmail={user.email} locale={locale}>
      <StaleDeploymentBanner />
      {children}
    </AppShell>
  );
}
