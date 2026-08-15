import "server-only";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

// Service-role client — bypasses RLS. SERVER ONLY. The `server-only` import above
// is a HARD build boundary (CH.3): importing this module into any Client Component
// bundle now fails the build, so the service-role key can never be shipped to the
// browser. Only imported by server actions / route handlers. The key must be set
// as SUPABASE_SERVICE_ROLE_KEY (not NEXT_PUBLIC).
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Service role not configured. Set SUPABASE_SERVICE_ROLE_KEY (server-only env var)."
    );
  }
  return createSupabaseClient(url, key, { auth: { persistSession: false } });
}
