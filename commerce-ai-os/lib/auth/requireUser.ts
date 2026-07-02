import { createClient } from "@/lib/supabase/server";

// Defense-in-depth auth gate for "use server" actions. Middleware already
// redirects unauthenticated page requests, but server actions are independently
// invokable POST endpoints, so each mutating action should verify the session
// too. Returns an { error } object (compatible with the actions' result shape)
// when there is no signed-in user, or null when the caller is authenticated.
export async function requireUser(): Promise<{ error: string } | null> {
  const {
    data: { user },
  } = await createClient().auth.getUser();
  if (!user) return { error: "غير مسجّل الدخول." };
  return null;
}

// Boolean form of the same gate, for actions whose "not signed in" branch needs
// a bespoke result shape/message (so they keep returning it verbatim instead of
// adopting requireUser's fixed one). Collapses the repeated
// `const { data: { user } } = await createClient().auth.getUser(); if (!user) …`
// idiom into one greppable call so a new action is less likely to omit it.
export async function isSignedIn(): Promise<boolean> {
  const {
    data: { user },
  } = await createClient().auth.getUser();
  return Boolean(user);
}
