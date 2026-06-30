"use server";

import crypto from "crypto";
import { cookies } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import { applyMovement } from "@/lib/inventory/movements";
import { signStaff, verifyStaff, STAFF_COOKIE } from "@/lib/staff/session";

// Constant-time compare against the shared staff PIN (server-only env var).
function pinOk(pin: string): boolean {
  const real = process.env.STAFF_PIN || "";
  if (!real || !pin) return false;
  const a = Buffer.from(String(pin));
  const b = Buffer.from(real);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function currentStaff(): Promise<{ name: string } | null> {
  const c = await cookies();
  return verifyStaff(c.get(STAFF_COOKIE)?.value);
}

export async function staffLogin(name: string, pin: string): Promise<{ error: string } | { ok: true; name: string }> {
  if (!process.env.STAFF_PIN) {
    return { error: "صفحة الموظفين غير مهيأة بعد (لم يُضبط STAFF_PIN على الخادم)." };
  }
  const nm = String(name || "").trim().slice(0, 40);
  if (!nm) return { error: "اكتب اسمك أولاً." };
  if (!pinOk(pin)) return { error: "الرمز غير صحيح." };
  const c = await cookies();
  c.set(STAFF_COOKIE, signStaff(nm), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/staff",
    maxAge: 12 * 60 * 60,
  });
  return { ok: true as const, name: nm };
}

export async function staffLogout() {
  const c = await cookies();
  c.delete(STAFF_COOKIE);
  return { ok: true as const };
}

export type StaffItem = {
  inventoryId: string;
  sku: string | null;
  name: string | null;
  name_ar: string | null;
  barcode: string | null;
  image: string | null;
  stock: number;
};

// Look up products to move — exact barcode first (scanner), else fuzzy by
// sku/name/barcode. Only returns rows that have an inventory record to move.
export async function staffLookup(query: string): Promise<{ items: StaffItem[]; error?: string }> {
  const who = await currentStaff();
  if (!who) return { items: [], error: "انتهت الجلسة — سجّل دخول مرة ثانية." };
  const q = String(query || "").trim();
  if (!q) return { items: [] };
  const admin = createAdminClient();

  const cols = "id, sku, name_en, name_ar, barcode, image_url";
  let prods: any[] = (await admin.from("products").select(cols).eq("barcode", q).limit(5)).data ?? [];
  if (prods.length === 0) {
    const like = `%${q.replace(/[%,()]/g, " ")}%`;
    prods =
      (await admin
        .from("products")
        .select(cols)
        .or(`sku.ilike.${like},name_en.ilike.${like},name_ar.ilike.${like},barcode.ilike.${like}`)
        .limit(20)).data ?? [];
  }
  if (prods.length === 0) return { items: [] };

  const ids = prods.map((p) => p.id);
  const invRows = (await admin.from("inventory").select("id, product_id, stock_quantity").in("product_id", ids)).data ?? [];
  const invByProduct = new Map<string, any>(invRows.map((r: any) => [r.product_id, r]));

  const items: StaffItem[] = [];
  for (const p of prods) {
    const inv = invByProduct.get(p.id);
    if (!inv) continue; // not stockable — skip
    items.push({
      inventoryId: String(inv.id),
      sku: p.sku ?? null,
      name: p.name_en ?? p.name_ar ?? null,
      name_ar: p.name_ar ?? null,
      barcode: p.barcode ?? null,
      image: p.image_url ?? null,
      stock: inv.stock_quantity ?? 0,
    });
  }
  return { items };
}

export async function recordStaffMovement(input: {
  inventoryId: string;
  sku?: string | null;
  type: "in" | "out";
  quantity: string | number;
  reason?: string | null;
}) {
  const who = await currentStaff();
  if (!who) return { error: "انتهت الجلسة — سجّل دخول مرة ثانية." };
  const admin = createAdminClient();
  return applyMovement(admin, {
    inventoryId: input.inventoryId,
    sku: input.sku ?? null,
    type: input.type,
    quantity: input.quantity,
    reason: input.reason ?? null,
    note: null,
    by: `staff:${who.name}`,
  });
}

export type StaffLogRow = { at: string | null; sku: string | null; dir: "in" | "out"; qty: number; by: string | null };

// Today's stock movements (newest first) for the on-screen confirmation list.
export async function staffToday(): Promise<{ rows: StaffLogRow[]; error?: string }> {
  const who = await currentStaff();
  if (!who) return { rows: [], error: "انتهت الجلسة." };
  const admin = createAdminClient();
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  const { data } = await admin
    .from("malak_audit")
    .select("created_at, action_type, sku, new_value, old_value, details")
    .in("action_type", ["stock_in", "stock_out"])
    .gte("created_at", since.toISOString())
    .order("created_at", { ascending: false })
    .limit(40);
  const rows: StaffLogRow[] = (data ?? []).map((r: any) => ({
    at: r.created_at ?? null,
    sku: r.sku ?? null,
    dir: r.action_type === "stock_in" ? "in" : "out",
    qty: Number(r?.details?.quantity ?? (Math.abs(Number(r.new_value) - Number(r.old_value)) || 0)),
    by: r?.details?.by ?? null,
  }));
  return { rows };
}
