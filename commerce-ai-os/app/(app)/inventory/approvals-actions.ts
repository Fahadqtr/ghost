"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/auth/requireUser";
import { editMovementQty, deleteMovement as deleteMovementCore, reverseMovement as reverseMovementCore, isChannelSaleAudit } from "@/lib/inventory/movements";

export type StaffMove = {
  id: number;
  at: string | null;
  by: string;            // employee name (staff: prefix stripped)
  dir: "in" | "out";
  qty: number;
  sku: string | null;
  name: string | null;
  image: string | null;
  reason: string | null;
  review: "pending" | "approved" | "reversed" | "deleted";
  edited: { from: number; to: number; by: string } | null; // set if the qty was changed
};

async function adminEmail(): Promise<string | null> {
  try {
    const { data } = await createClient().auth.getUser();
    return data.user?.email ?? null;
  } catch {
    return null;
  }
}

// Service-role client, or null if it isn't configured on this deploy (e.g. a
// preview without the key) — so callers degrade to a message, not a crash.
function adminClient(): any | null {
  try {
    return createAdminClient();
  } catch {
    return null;
  }
}
const NO_DB = "الخادم غير مهيأ (SUPABASE_SERVICE_ROLE_KEY غير مضبوط على هذه النسخة).";

// All staff (PIN-page) movements, newest first, with product name/image resolved.
export async function getStaffMovements(limit = 100): Promise<{ rows: StaffMove[]; pending: number; error?: string }> {
  const unauth = await requireUser();
  if (unauth) return { rows: [], pending: 0, error: unauth.error };
  const admin = adminClient();
  if (!admin) return { rows: [], pending: 0, error: NO_DB };

  const { data, error } = await admin
    .from("malak_audit")
    .select("id, created_at, agent, action_type, sku, details")
    .like("agent", "staff:%")
    .in("action_type", ["stock_in", "stock_out"])
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return { rows: [], pending: 0, error: error.message };

  // resolve product names/images by the sku set
  const skus = Array.from(new Set((data ?? []).map((r: any) => r.sku).filter(Boolean)));
  const bySku = new Map<string, { name: string | null; image: string | null }>();
  for (let i = 0; i < skus.length; i += 200) {
    const { data: ps } = await admin.from("products").select("sku, name_en, name_ar, image_url").in("sku", skus.slice(i, i + 200));
    for (const p of (ps ?? []) as any[]) bySku.set(p.sku, { name: p.name_en ?? p.name_ar ?? null, image: p.image_url ?? null });
  }

  const rows: StaffMove[] = (data ?? []).map((r: any) => {
    const prod = r.sku ? bySku.get(r.sku) : null;
    const rv = r.details?.review;
    const review = rv === "approved" ? "approved" : rv === "reversed" ? "reversed" : rv === "deleted" ? "deleted" : "pending";
    const e = r.details?.edited;
    return {
      id: r.id,
      at: r.created_at ?? null,
      by: String(r.details?.by ?? r.agent ?? "").replace(/^staff:/, ""),
      dir: r.action_type === "stock_in" ? "in" : "out",
      qty: Number(r.details?.quantity ?? 0),
      sku: r.sku ?? null,
      name: prod?.name ?? null,
      image: prod?.image ?? null,
      reason: r.details?.reason ?? null,
      review,
      edited: e && typeof e.from === "number" ? { from: Number(e.from), to: Number(e.to), by: String(e.by ?? "").replace(/^staff:/, "") } : null,
    };
  });
  const pending = rows.filter((r) => r.review === "pending").length;
  return { rows, pending };
}

// Mark a movement as reviewed/approved (no stock change — it already applied).
export async function approveMovements(ids: number[]) {
  const unauth = await requireUser();
  if (unauth) return unauth;
  if (!ids?.length) return { ok: true as const, updated: 0 };
  const admin = adminClient();
  if (!admin) return { error: NO_DB };
  const email = await adminEmail();
  const now = new Date().toISOString();
  let updated = 0;
  for (const id of ids) {
    const { data: row } = await admin.from("malak_audit").select("details").eq("id", id).single();
    if (!row) continue;
    // INV.5 — never approve an automatic channel sale through the staff endpoint.
    if (isChannelSaleAudit(row)) continue;
    const details = { ...(row.details ?? {}), review: "approved", reviewedBy: email, reviewedAt: now };
    const { error } = await admin.from("malak_audit").update({ details }).eq("id", id);
    if (!error) updated++;
  }
  revalidatePath("/inventory/approvals");
  return { ok: true as const, updated };
}

// Reverse a movement: apply the exact inverse + a distinct immutable reversal
// audit row and mark the original reversed — one atomic RPC (INV.6A). Use when an
// employee logged a wrong in/out. The RPC enforces channel-sale immutability.
export async function reverseMovement(id: number) {
  const unauth = await requireUser();
  if (unauth) return unauth;
  const admin = adminClient();
  if (!admin) return { error: NO_DB };
  const email = await adminEmail();
  const res = await reverseMovementCore(admin, Number(id), `reversal:${email ?? "admin"}`);
  if ("error" in res) return res;
  revalidatePath("/inventory/approvals");
  revalidatePath("/inventory");
  return { ok: true as const };
}

// Manager: change a movement's quantity (adjusts stock by the delta).
export async function editMovement(id: number, newQty: number) {
  const unauth = await requireUser();
  if (unauth) return unauth;
  const admin = adminClient();
  if (!admin) return { error: NO_DB };
  const email = await adminEmail();
  return editMovementQty(admin, id, newQty, `admin:${email ?? "manager"}`);
}

// Manager: delete a movement (undo its stock effect + mark it deleted).
export async function deleteMovement(id: number) {
  const unauth = await requireUser();
  if (unauth) return unauth;
  const admin = adminClient();
  if (!admin) return { error: NO_DB };
  const email = await adminEmail();
  return deleteMovementCore(admin, id, `admin:${email ?? "manager"}`);
}
