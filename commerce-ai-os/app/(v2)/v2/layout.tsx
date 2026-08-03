// Malikas V2 route-group layout (Phase UI.1). Independent of the legacy AppShell.
// Server Component: authenticates through the existing Supabase user session and
// redirects unauthenticated visitors to /login. No service role, no admin client.

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import V2Shell from "@/components/v2/V2Shell";

export default async function V2Layout({ children }: { children: React.ReactNode }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  return <V2Shell userEmail={user.email}>{children}</V2Shell>;
}
