"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/auth/requireUser";
import { hashPin, isLegacyPlaintextPin } from "@/lib/staff/pin";
import { parsePermissions, type StaffPermission } from "@/lib/staff/permissions";

// The PIN is never returned to the client — it's stored hashed and shown to the
// manager only once, at create/reset time. `hasCode` just tells the UI a code
// is set so it can render a masked placeholder.
export type StaffMember = {
  id: string;
  name: string;
  hasCode: boolean;
  active: boolean;
  permissions: StaffPermission[];
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
  // select("*") so a missing permissions column (pre-migration) doesn't fail.
  const { data, error } = await admin
    .from("staff_members")
    .select("*")
    .order("created_at", { ascending: true });
  if (error) {
    // 42P01 = undefined_table → migration not run yet.
    if ((error as any).code === "42P01" || /staff_members/.test(error.message)) return { members: [], ready: false };
    return { members: [], ready: true, error: error.message };
  }
  const rows = (data ?? []) as { id: string; name: string; pin: string | null; active: boolean; permissions?: unknown; created_at: string | null }[];

  // Upgrade any employee still on a legacy plaintext PIN to its hash so codes
  // never linger in the DB as cleartext once the owner has opened this page.
  const legacy = rows.filter((r) => isLegacyPlaintextPin(r.pin));
  for (const r of legacy) {
    await admin.from("staff_members").update({ pin: hashPin(r.pin as string) }).eq("id", r.id);
  }

  const members: StaffMember[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    hasCode: !!r.pin,
    active: r.active,
    permissions: parsePermissions(r.permissions),
    created_at: r.created_at,
  }));
  return { members, ready: true };
}

// Set the granted capabilities for one employee. Takes effect on their /staff
// page immediately (permissions are re-read live per action).
export async function setStaffPermissions(id: string, permissions: string[]) {
  const unauth = await requireUser();
  if (unauth) return unauth;
  const clean = parsePermissions(permissions);
  const admin = adminClient();
  if (!admin) return { error: NO_DB };
  const { error } = await admin.from("staff_members").update({ permissions: clean }).eq("id", id);
  if (error) {
    if ((error as any).code === "42703" || /permissions/.test(error.message)) {
      return { error: "عمود الصلاحيات غير موجود — شغّل supabase/staff_permissions.sql أولاً." };
    }
    return { error: error.message };
  }
  revalidatePath("/team");
  return { ok: true as const, permissions: clean };
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
  const { error } = await admin.from("staff_members").insert({ name: nm, pin: hashPin(code), active: true });
  if (error) {
    if ((error as any).code === "23505" || /duplicate|unique/i.test(error.message)) return { error: "هذا الرمز مستخدم لموظف آخر — اختر رمزًا غيره." };
    if ((error as any).code === "42P01") return { error: "الجدول غير موجود — شغّل supabase/staff_members.sql أولاً." };
    return { error: error.message };
  }
  revalidatePath("/team");
  return { ok: true as const };
}

// Set a new code for an existing employee. The manager sees it once (in the
// caller's flash message); only the hash is stored.
export async function resetStaffPin(id: string, pin: string) {
  const unauth = await requireUser();
  if (unauth) return unauth;
  const code = String(pin || "").trim();
  if (!/^\d{4,8}$/.test(code)) return { error: "الرمز لازم 4–8 أرقام." };
  const admin = adminClient();
  if (!admin) return { error: NO_DB };
  const { error } = await admin.from("staff_members").update({ pin: hashPin(code) }).eq("id", id);
  if (error) {
    if ((error as any).code === "23505" || /duplicate|unique/i.test(error.message)) return { error: "هذا الرمز مستخدم لموظف آخر — اختر رمزًا غيره." };
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
