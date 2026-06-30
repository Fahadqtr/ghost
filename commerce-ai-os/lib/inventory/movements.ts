import "server-only";
import { revalidatePath } from "next/cache";

// Shared stock IN/OUT engine, used by BOTH the admin movements action
// (recordMovement) and the staff page (recordStaffMovement). Auth is the
// caller's job — this just does the read-modify-write + audit ledger so the two
// entry points can never drift in how stock is mutated.

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
  const qty = Math.floor(Math.abs(Number(input.quantity)));
  if (!input.inventoryId || !qty || Number.isNaN(qty)) {
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
  const delta = input.type === "in" ? qty : -qty;
  const after = before + delta;
  if (after < 0) {
    return { error: `الكمية غير كافية: المتوفّر ${before}، وحاولت إخراج ${qty}.` };
  }

  const patch: Record<string, unknown> = { stock_quantity: after, updated_at: new Date().toISOString() };
  if (input.type === "out" && (input.reason ?? "").toLowerCase() === "sale") {
    patch.sold_quantity = (inv.sold_quantity ?? 0) + qty;
  }

  const { error: upErr } = await admin.from("inventory").update(patch).eq("id", inv.id);
  if (upErr) return { error: upErr.message };

  // Best-effort ledger row (the stock change already succeeded). Keep the uuid in
  // `details` — malak_audit.product_id is a legacy bigint, not the products uuid.
  const { error: logErr } = await admin.from("malak_audit").insert({
    agent: input.by || "inventory",
    action: input.type === "in" ? "stock_in" : "stock_out",
    action_type: input.type === "in" ? "stock_in" : "stock_out",
    sku: input.sku ?? null,
    field: "stock_quantity",
    old_value: String(before),
    new_value: String(after),
    status: "done",
    details: {
      productId: inv.product_id ?? null,
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
  return { ok: true, before, after, qty, sku: input.sku ?? null };
}
