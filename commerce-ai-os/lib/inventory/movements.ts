import "server-only";
import { revalidatePath } from "next/cache";
import { normalizeQty } from "./compute.ts";
import {
  recordProductMovement,
  editProductMovement,
  deleteProductMovement as engineDeleteProductMovement,
  reverseMovement as engineReverseMovement,
  type EngineResult,
} from "./engine.ts";
import { logAuthoritativeStockTransition } from "./transition.ts";

// INV.6A — the manual product-grain movement engine, CONVERGED onto the atomic
// Inventory Engine RPCs. This file performs ZERO direct inventory writes and NO
// numeric read-modify-write in TypeScript: applyMovement / editMovementQty /
// deleteMovement each drive one SECURITY DEFINER RPC (record / edit / delete)
// that mutates stock + sold_quantity + the malak_audit ledger atomically, in
// BIGINT, fail-closed, with NO clamp. The authoritative before/after come back
// from the RPC — never recomputed here. Auth is the caller's job; this owns the
// Engine call + friendly message mapping + best-effort zero-crossing transition.

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

// INV.5 — immutability guard for automatic CHANNEL SALE audits (pure rule lives in
// ./channel-immutability.ts so node:test can import it without this file's next/cache
// + @/ dependencies). Re-exported here for the movement/approval call sites.
export { isChannelSaleAudit, CHANNEL_SALE_LOCKED_MSG } from "./channel-immutability.ts";
import { CHANNEL_SALE_LOCKED_MSG } from "./channel-immutability.ts";

// Map an Engine movement failure to a staff/manager-facing Arabic message.
function movementMessage(r: Extract<EngineResult, { ok: false }>): string {
  switch (r.reason) {
    case "movement_locked":
      return CHANNEL_SALE_LOCKED_MSG;
    case "insufficient_stock":
      return "الكمية غير كافية في المخزون.";
    case "cannot_undo_consumed_stock":
      return "لا يمكن التراجع — الكمية المُدخلة استُهلكت من المخزون.";
    case "sold_inconsistent":
      return "لا يمكن التراجع — قيمة المبيعات غير متسقة.";
    case "product_has_variants":
      return "هذا المنتج له خيارات — عدّل مخزون الخيار.";
    case "product_has_shelf_rows":
      return "المنتج موزّع على رفوف — استخدم جرد الرفوف.";
    case "inventory_inconsistent":
      return "حالة المخزون غير متسقة — راجع المنتج.";
    case "missing_inventory":
      return "صف المخزون غير موجود.";
    case "movement_not_found":
      return "الحركة غير موجودة.";
    case "movement_reversed":
    case "already_reversed":
      return "هذه الحركة معكوسة مسبقًا.";
    case "movement_deleted":
    case "already_deleted":
      return "الحركة محذوفة مسبقًا.";
    case "not_a_product_movement":
      return "نوع الحركة لا يقبل هذا الإجراء.";
    case "movement_details_missing":
      return "تفاصيل الحركة ناقصة — لا يمكن تنفيذ الإجراء.";
    case "overflow":
      return "الكمية كبيرة جدًا.";
    case "invalid_direction":
    case "invalid_delta":
    case "invalid_sold_delta":
    case "sold_delta_mismatch":
    case "invalid_quantity":
      return "كمية أو حركة غير صالحة.";
    default:
      return "تعذّر تنفيذ حركة المخزون.";
  }
}

function revalidateMovementPaths(): void {
  revalidatePath("/inventory");
  revalidatePath("/inventory/movements");
  revalidatePath("/inventory/approvals");
  revalidatePath("/staff");
  revalidatePath("/dashboard");
}

/** Apply a movement with an already-authorized (service-role) client. */
export async function applyMovement(admin: any, input: MovementInput): Promise<MovementResult> {
  const qty = normalizeQty(input.quantity);
  if (!input.inventoryId || !qty) {
    return { error: "اختر منتجًا وكمية أكبر من صفر." };
  }
  if (input.type !== "in" && input.type !== "out") return { error: "نوع حركة غير صالح." };

  const res = await recordProductMovement(admin, {
    inventoryId: input.inventoryId,
    direction: input.type,
    quantity: qty,
    reason: input.reason ?? null,
    note: input.note ?? null,
    actor: input.by ?? "inventory",
    sku: input.sku ?? null,
  });
  if (!res.ok) return { error: movementMessage(res) };

  const before = Number(res.data.before);
  const after = Number(res.data.after);
  // Authoritative zero-crossing transition (best-effort) — engine before/after,
  // never the double-counting totalStock helper.
  await logAuthoritativeStockTransition(admin, { productId: (res.data.productId as string | null) ?? null, before, after, actor: input.by ?? undefined });

  revalidateMovementPaths();
  return { ok: true, before, after, qty, sku: input.sku ?? null };
}

// Edit a movement's quantity in place through the atomic edit RPC (adjusts stock
// — and sold_quantity for a canonical sale — by the delta, records editHistory,
// keeps the review state). No JS arithmetic, no clamp. Auth is the caller's job.
export async function editMovementQty(admin: any, id: number, newQty: number, actor: string): Promise<{ ok: true; qty: number } | { error: string }> {
  const q = normalizeQty(newQty);
  if (!q) return { error: "الكمية لازم تكون أكبر من صفر." };

  const res = await editProductMovement(admin, { auditId: Number(id), newQuantity: q, actor });
  if (!res.ok) return { error: movementMessage(res) };

  const before = res.data.stockBefore;
  const after = res.data.stockAfter;
  if (typeof before === "number" && typeof after === "number" && before !== after) {
    await logAuthoritativeStockTransition(admin, { productId: (res.data.productId as string | null) ?? null, before, after, actor });
  }

  revalidateMovementPaths();
  return { ok: true, qty: q };
}

// Delete a movement through the atomic delete RPC: undo its stock effect (unless
// already reversed) and mark the audit row deleted (kept visible). No clamp.
export async function deleteMovement(admin: any, id: number, actor: string): Promise<{ ok: true } | { error: string }> {
  const res = await engineDeleteProductMovement(admin, { auditId: Number(id), actor });
  if (!res.ok) return { error: movementMessage(res) };

  const before = res.data.stockBefore;
  const after = res.data.stockAfter;
  if (typeof before === "number" && typeof after === "number" && before !== after) {
    await logAuthoritativeStockTransition(admin, { productId: (res.data.productId as string | null) ?? null, before, after, actor });
  }

  revalidateMovementPaths();
  return { ok: true };
}

// Reverse a movement through the atomic reverse RPC: apply the exact inverse,
// insert a distinct immutable reversal audit row, and mark the original reversed
// — all in one transaction. No clamp. Auth is the caller's job.
export async function reverseMovement(admin: any, id: number, actor: string): Promise<{ ok: true } | { error: string }> {
  const res = await engineReverseMovement(admin, { auditId: Number(id), actor });
  if (!res.ok) return { error: movementMessage(res) };

  const before = Number(res.data.before);
  const after = Number(res.data.after);
  if (before !== after) {
    await logAuthoritativeStockTransition(admin, { productId: (res.data.productId as string | null) ?? null, before, after, actor });
  }

  revalidateMovementPaths();
  return { ok: true };
}
