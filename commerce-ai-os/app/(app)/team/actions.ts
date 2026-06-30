"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/auth/requireUser";

export type StaffMember = {
  id: string;
  name: string;
  pin: string;
  active: boolean;
  created_at: string | null;
};

function adminClient(): any | null {
  try { return createAdminClient(); } catch { return null; }
}
const NO_DB = "الخادم غير مهيأ (SUPABASE_SERVICE_ROLE_KEY غير مضبوط).";

// Lists employees. `ready=false` means the staff_members table isn't created yet
// (run supabase/staff_members.sql once) — the page shows a one-time setup note.
export async function listStaff(): Promise<{ members: StaffMember[]; ready: boolean; error?: string }> {
  const unauth = await requireUser();
  if (unauth) return { members: [], ready: true, error: unauth.error };
  const admin = adminClient();
  if (!admin) return { members: [], ready: true, error: NO_DB };
  const { data, error } = await admin
    .from("staff_members")
    .select("id, name, pin, active, created_at")
    .order("created_at", { ascending: true });
  if (error) {
    // 42P01 = undefined_table → migration not run yet.
    if ((error as any).code === "42P01" || /staff_members/.test(error.message)) return { members: [], ready: false };
    return { members: [], ready: true, error: error.message };
  }
  return { members: (data ?? []) as StaffMember[], ready: true };
}

export async function addStaff(name: string, pin: string) {
  const unauth = await requireUser();
  if (unauth) return unauth;
  const nm = String(name || "").trim().slice(0, 40);
  const code = String(pin || "").trim();
  if (!nm) return { error: "اكتب اسم الموظف." };
  if (!/^\d{4,8}$/.test(code)) return { error: "الرمز لازم 4–8 أرقام." };
  const admin = adminClient();
  if (!admin) return { error: NO_DB };
  const { error } = await admin.from("staff_members").insert({ name: nm, pin: code, active: true });
  if (error) {
    if ((error as any).code === "23505" || /duplicate|unique/i.test(error.message)) return { error: "هذا الرمز مستخدم لموظف آخر — اختر رمزًا غيره." };
    if ((error as any).code === "42P01") return { error: "الجدول غير موجود — شغّل supabase/staff_members.sql أولاً." };
    return { error: error.message };
  }
  revalidatePath("/team");
  return { ok: true as const };
}

export async function setStaffActive(id: string, active: boolean) {
  const unauth = await requireUser();
  if (unauth) return unauth;
  const admin = adminClient();
  if (!admin) return { error: NO_DB };
  const { error } = await admin.from("staff_members").update({ active }).eq("id", id);
  if (error) return { error: error.message };
  revalidatePath("/team");
  return { ok: true as const };
}

export async function deleteStaff(id: string) {
  const unauth = await requireUser();
  if (unauth) return unauth;
  const admin = adminClient();
  if (!admin) return { error: NO_DB };
  const { error } = await admin.from("staff_members").delete().eq("id", id);
  if (error) return { error: error.message };
  revalidatePath("/team");
  return { ok: true as const };
}
