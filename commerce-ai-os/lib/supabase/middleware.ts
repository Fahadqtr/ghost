// Session refresh + route protection for the whole app.
// Runs on every matched request (see middleware.ts at project root).
import {
  createServerClient,
  type CookieOptions,
} from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Paths that are reachable WITHOUT being logged in. `/staff` is the employees'
// stock IN/OUT page — it has its own shared-PIN gate (no Supabase account).
// `/api/cron` runs on a schedule with no user cookie — redirecting it to /login
// would 307 the job away from its handler; it authenticates itself with the
// CRON_SECRET bearer token instead.
// `/rewards` + `/api/rewards` are the customer-facing Beauty Rewards loyalty
// flow, opened from a printed QR by people who have no account — they must be
// public (the writes are guarded by the service-role key inside lib/loyalty).
const PUBLIC_PATHS = [
  "/login",
  "/auth",
  "/staff",
  "/rewards",
  "/api/cron",
  "/api/webhooks",
  "/api/rewards",
];

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  const path = request.nextUrl.pathname;
  const isPublic = PUBLIC_PATHS.some(
    (p) => path === p || path.startsWith(p + "/")
  );

  // If Supabase isn't configured we can't verify anyone. In production that's a
  // misconfiguration — fail CLOSED (send protected routes to /login) rather than
  // serving the whole app unauthenticated. In dev, pass through so local work
  // without env vars isn't blocked.
  if (!url || !key) {
    if (process.env.NODE_ENV === "production" && !isPublic) {
      const redirectUrl = request.nextUrl.clone();
      redirectUrl.pathname = "/login";
      return NextResponse.redirect(redirectUrl);
    }
    return supabaseResponse;
  }

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(
        cookiesToSet: { name: string; value: string; options?: CookieOptions }[]
      ) {
        cookiesToSet.forEach(({ name, value }) =>
          request.cookies.set(name, value)
        );
        supabaseResponse = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          supabaseResponse.cookies.set(name, value, options)
        );
      },
    },
  });

  // IMPORTANT: getUser() revalidates the token with Supabase Auth.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Not logged in and trying to reach a protected page -> /login
  if (!user && !isPublic) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/login";
    return NextResponse.redirect(redirectUrl);
  }

  // Already logged in and visiting /login -> /dashboard
  if (user && path === "/login") {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/dashboard";
    return NextResponse.redirect(redirectUrl);
  }

  return supabaseResponse;
}
