import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

// Next 16 renamed the root "middleware" file convention to "proxy" (same
// request-interception role). The session-refresh logic still lives in
// lib/supabase/middleware.ts.
export async function proxy(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: [
    // Run on all paths except Next internals, static asset files, and the public
    // PWA assets. The manifest + icon routes MUST stay public: if auth redirects
    // them to /login the phone can't read the manifest, so "Add to Home Screen"
    // loses display:standalone and the app opens zoomed-out (PC-sized) instead of
    // at app size.
    "/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|icon|apple-icon|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
