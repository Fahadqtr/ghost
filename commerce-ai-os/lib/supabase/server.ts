// Server-side Supabase client (for Server Components, Route Handlers, Server Actions).
// Wires Supabase Auth to Next.js cookies so sessions persist across requests.
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";

export function createClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error(
      "Missing Supabase env vars. Copy .env.local.example to .env.local and fill in NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY."
    );
  }

  // Next 15 made `cookies()` async. We await it lazily inside the cookie
  // adapter (supported by @supabase/ssr) so `createClient()` itself stays
  // synchronous — no need to thread `await` through every call site.
  return createServerClient(url, key, {
    cookies: {
      async getAll() {
        return (await cookies()).getAll();
      },
      async setAll(
        cookiesToSet: { name: string; value: string; options?: CookieOptions }[]
      ) {
        try {
          const cookieStore = await cookies();
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          );
        } catch {
          // `setAll` can be called from a Server Component where cookies are
          // read-only. Safe to ignore when middleware refreshes the session.
        }
      },
    },
  });
}

/** Returns true when real Supabase credentials are configured (not placeholders). */
export function isSupabaseConfigured(): boolean {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
  return (
    url.startsWith("https://") &&
    !url.includes("YOUR-PROJECT-ref") &&
    key.length > 0 &&
    !key.includes("YOUR-ANON")
  );
}
