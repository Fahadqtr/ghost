// Malak WRITE authorization (F2). Reading/chatting is open to any signed-in
// user; mutating the catalog (price/stock/approval/add/image/sync) is limited to
// an allow-list. The owner is always included so a misconfigured env can never
// lock writes out; extra writers come from MALAK_WRITER_EMAILS (comma-separated).
import { createClient } from "@/lib/supabase/server";

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
