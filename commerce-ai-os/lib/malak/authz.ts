// Malak WRITE authorization (F2). Reading/chatting is open to any signed-in
// user; mutating the catalog (price/stock/approval/add/image/sync) is limited to
// an allow-list. The owner is always included so a misconfigured env can never
// lock writes out; extra writers come from MALAK_WRITER_EMAILS (comma-separated).
import { createClient } from "@/lib/supabase/server";
import { decideOwner, OWNER_ONLY_DENIED, type OwnerDecision } from "./owner-check";

const OWNER_EMAIL = "clanqtr@gmail.com";

function writerSet(): Set<string> {
  const extra = (process.env.MALAK_WRITER_EMAILS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return new Set([OWNER_EMAIL, ...extra]);
}

export type WriterCheck =
  | { ok: true; email: string }
  | { ok: false; status: 401 | 403; error: string };

// Verify the caller is signed in AND on the writer allow-list.
export async function requireMalakWriter(): Promise<WriterCheck> {
  const { data: { user } } = await createClient().auth.getUser();
  if (!user) return { ok: false, status: 401, error: "غير مسجّل الدخول." };
  const email = (user.email ?? "").toLowerCase();
  if (!email || !writerSet().has(email)) {
    return { ok: false, status: 403, error: "ما عندك صلاحية التعديل عبر ملاك — للقراءة فقط." };
  }
  return { ok: true, email };
}

export type OwnerCheck = OwnerDecision;

// Re-export the constant denial so callers import it from the auth module.
export { OWNER_ONLY_DENIED };

/**
 * OWNER-ONLY gate for actions that publish/message externally or spend external
 * media/AI credits with immediate external effect. Stricter than
 * requireMalakWriter: MALAK_WRITER_EMAILS does NOT grant it — only OWNER_EMAIL,
 * verified from the server-side Supabase session (never a client-supplied
 * value). The decision itself is the pure, unit-tested decideOwner().
 */
export async function requireOwner(): Promise<OwnerCheck> {
  const { data: { user } } = await createClient().auth.getUser();
  return decideOwner(!!user, user?.email ?? null, OWNER_EMAIL);
}

/** Boolean owner check for UI gating (server-computed; not a security boundary). */
export async function isOwner(): Promise<boolean> {
  const { data: { user } } = await createClient().auth.getUser();
  return decideOwner(!!user, user?.email ?? null, OWNER_EMAIL).ok;
}
