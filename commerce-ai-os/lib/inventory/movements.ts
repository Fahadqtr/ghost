import "server-only";
import { revalidatePath } from "next/cache";
import { insertAuditRow } from "@/lib/audit";
import { normalizeQty, planApply, planEdit, planDelete } from "./movements-compute";

// Shared stock IN/OUT engine, used by BOTH the admin movements action
// (recordMovement) and the staff page (recordStaffMovement). Auth is the
// caller's job — this just does the read-modify-write + audit ledger so the two
// entry points can never drift in how stock is mutated. The delta arithmetic is
// pure and unit-tested in movements-compute.ts; this file owns the I/O.

export type MovementInput = {
  inventoryId: string;
  sku?: string | null;
  type: "in" | "out";
  quantity: string | number;
  reason?: string | null;
  note?: string | null;
  by?: string | null;
};

export type MovementResult =
  | { error: string }
  | { ok: true; before: number; after: number; qty: number; sku: string | null };

/** Apply a movement with an already-authorized (service-role) client. */
export async function applyMovement(admin: any, input: MovementInput): Promise<MovementResult> {
  const qty = normalizeQty(input.quantity);
  if (!input.inventoryId || !qty) {
    return { error: "اختر منتجًا وكمية أكبر من صفر." };
  }
  if (input.type !== "in" && input.type !== "out") return { error: "نوع حركة غير صالح." };

  const { data: inv, error: readErr } = await admin
    .from("inventory")
    .select("id, stock_quantity, sold_quantity, product_id")
    .eq("id", input.inventoryId)
    .single();
  if (readErr || !inv) return { error: "صف المخزون غير موجود." };

  const before = inv.stock_quantity ?? 0;
  const plan = planApply({ type: input.type, qty, before, sold: inv.sold_quantity ?? 0, reason: input.reason });
  if ("error" in plan) return { error: plan.error };

  const patch: Record<string, unknown> = { stock_quantity: plan.after, updated_at: new Date().toISOString() };
  if (plan.soldAfter != null) patch.sold_quantity = plan.soldAfter;

  const { error: upErr } = await admin.from("inventory").update(patch).eq("id", inv.id);
  if (upErr) return { error: upErr.message };

  // Best-effort ledger row (the stock change already succeeded). product_id is
  // written directly (uuid after the malak_audit_product_id_uuid.sql migration;
  // insertAuditRow falls back to the legacy details-only shape before it).
  const { error: logErr } = await insertAuditRow(admin, {
    agent: input.by || "inventory",
    action: input.type === "in" ? "stock_in" : "stock_out",
    action_type: input.type === "in" ? "stock_in" : "stock_out",
    sku: input.sku ?? null,
    product_id: inv.product_id ?? null,
    field: "stock_quantity",
    old_value: String(before),
    new_value: String(plan.after),
    status: "done",
    details: {
      productId: inv.product_id ?? null,
      inventoryId: inv.id, // lets the approvals dashboard reverse precisely
      quantity: qty,
      direction: input.type,
      reason: input.reason ?? null,
      note: input.note ?? null,
      by: input.by ?? null,
    },
  });
  if (logErr) console.error("[applyMovement] audit insert failed:", logErr.message);

  revalidatePath("/inventory");
  revalidatePath("/inventory/movements");
  revalidatePath("/dashboard");
  return { ok: true, before, after: plan.after, qty, sku: input.sku ?? null };
}

// Edit a movement's quantity in place: adjust inventory by the delta (and
// sold_quantity for sales), then record the edit on the audit row. Keeps the
// review state (an edit doesn't approve it). Auth is the caller's job.
export async function editMovementQty(admin: any, id: number, newQty: number, actor: string): Promise<{ ok: true; qty: number } | { error: string }> {
  const q = normalizeQty(newQty);
  if (!q) return { error: "الكمية لازم تكون أكبر من صفر." };
  const { data: row } = await admin.from("malak_audit").select("action_type, old_value, details").eq("id", id).single();
  if (!row) return { error: "الحركة غير موجودة." };
  const rev = row.details?.review;
  if (rev === "reversed" || rev === "deleted") return { error: "لا يمكن تعديل حركة محذوفة أو معكوسة." };
  const inventoryId = row.details?.inventoryId;
  const oldQty = Number(row.details?.quantity ?? 0);
  if (!inventoryId || !oldQty) return { error: "تفاصيل الحركة ناقصة — لا يمكن تعديلها." };
  if (q === oldQty) return { ok: true, qty: q };

  const dir = row.action_type === "stock_in" ? "in" : "out";
  const reason = String(row.details?.reason ?? "");
  const { data: inv } = await admin.from("inventory").select("stock_quantity, sold_quantity").eq("id", inventoryId).single();
  if (!inv) return { error: "صف المخزون غير موجود." };

  const plan = planEdit({ dir, reason, oldQty, newQty: q, stock: inv.stock_quantity, sold: inv.sold_quantity, oldValue: row.old_value });
  const patch: Record<string, unknown> = { stock_quantity: plan.stockAfter, updated_at: new Date().toISOString() };
  if (plan.soldAfter != null) patch.sold_quantity = plan.soldAfter;
  await admin.from("inventory").update(patch).eq("id", inventoryId);

  const hist = Array.isArray(row.details?.editHistory) ? row.details.editHistory : [];
  hist.push({ by: actor, at: new Date().toISOString(), from: oldQty, to: q });
  const details = { ...(row.details ?? {}), quantity: q, edited: { by: actor, at: new Date().toISOString(), from: oldQty, to: q }, editHistory: hist };
  await admin.from("malak_audit").update(plan.newValue != null ? { details, new_value: plan.newValue } : { details }).eq("id", id);

  revalidatePath("/inventory");
  revalidatePath("/inventory/approvals");
  revalidatePath("/staff");
  return { ok: true, qty: q };
}

// Delete a movement: undo its stock effect (unless already reversed) and mark
// the audit row deleted — kept visible so the manager can see it happened.
export async function deleteMovement(admin: any, id: number, actor: string): Promise<{ ok: true } | { error: string }> {
  const { data: row } = await admin.from("malak_audit").select("action_type, details").eq("id", id).single();
  if (!row) return { error: "الحركة غير موجودة." };
  const rev = row.details?.review;
  if (rev === "deleted") return { error: "الحركة محذوفة مسبقًا." };
  const inventoryId = row.details?.inventoryId;
  const qty = Number(row.details?.quantity ?? 0);
  const dir = row.action_type === "stock_in" ? "in" : "out";
  const reason = String(row.details?.reason ?? "");

  if (inventoryId && qty && rev !== "reversed") {
    const { data: inv } = await admin.from("inventory").select("stock_quantity, sold_quantity").eq("id", inventoryId).single();
    if (inv) {
      const plan = planDelete({ dir, reason, qty, stock: inv.stock_quantity, sold: inv.sold_quantity });
      const patch: Record<string, unknown> = { stock_quantity: plan.stockAfter, updated_at: new Date().toISOString() };
      if (plan.soldAfter != null) patch.sold_quantity = plan.soldAfter;
      await admin.from("inventory").update(patch).eq("id", inventoryId);
    }
  }

  const details = { ...(row.details ?? {}), review: "deleted", deletedBy: actor, deletedAt: new Date().toISOString() };
  await admin.from("malak_audit").update({ details }).eq("id", id);
  revalidatePath("/inventory");
  revalidatePath("/inventory/approvals");
  revalidatePath("/staff");
  return { ok: true };
}
