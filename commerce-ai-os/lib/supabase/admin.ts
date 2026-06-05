import { createClient as createSupabaseClient } from "@supabase/supabase-js";

// Service-role client — bypasses RLS. SERVER ONLY (only imported by server
// actions). The key must be set as SUPABASE_SERVICE_ROLE_KEY (not NEXT_PUBLIC).
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
