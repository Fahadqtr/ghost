import "server-only";
import { reconcile as reconcileProductState } from "./reconcile.ts";
import type { ReconcileResult } from "./reconcile.ts";

// INV.3D — Inventory Engine facade (server-side).
//
// The official entry point that will become the SOLE owner of every numeric
// inventory mutation. In INV.3D it is ADDITIVE ONLY — no runtime writer is wired
// to it yet (that is INV.4A+). It is a thin facade that DELEGATES:
//   * pure arithmetic          → lib/inventory/compute.ts        (not duplicated)
//   * reconciliation (read)    → lib/inventory/reconcile.ts      (not duplicated)
//   * zero-crossing tasks      → lib/inventory/transition.ts     (not duplicated)
//   * atomic multi-table writes→ INV.3C RPCs (inv_adjust_variant,
//                                inv_set_variant_absolute, inv_place_shelf)
//
// AVAILABILITY BOUNDARY (hard): the engine owns NUMERIC inventory only. It never
// reads or writes products.stock_status / product_variants.stock_status, never
// infers availability from quantity (0 is not "unavailable", >0 is not
// "available"), and imports NO availability write API. The Availability Engine
// (lib/availability/*) stays entirely separate.
//
// FAIL-CLOSED: an RPC is treated as successful ONLY when the transport succeeds
// AND the payload is a well-formed { status:'applied', ... } with the expected
// derived fields. Transport error / malformed response / status:'error' /
// missing data → the operation FAILS. There is NEVER a fallback to a direct JS
// write.
//
// TRANSITIONS: the INV.3C RPCs deliberately do not open stock tasks in SQL; they
// return before/after + derived totals so the CALLER owns transition firing via
// lib/inventory/transition.ts (the official transition surface). In INV.3D the
// RPC wrappers do NOT auto-fire transitions — the INV.3B finding (totalStock may
// double-count variant+parent) means firing here, before a real writer is
// migrated, could change or double-fire semantics. The writer-migration phase
// (INV.4A+) imports transition.ts directly and wires it explicitly. This module
// deliberately does NOT eagerly re-export transition.ts (a) to keep the facade
// additive/unused and (b) so it stays DB-free-testable. totalStock behavior is
// NOT changed by this module.

export type { ReconcileResult } from "./reconcile.ts";

// ── Result contract ─────────────────────────────────────────────────────────

export type EngineResult =
  | { ok: true; op: string; data: Record<string, unknown> }
  | { ok: false; op: string; reason: string; raw?: unknown };

/**
 * Fail-closed interpreter for an INV.3C RPC response. Success requires: no
 * transport error, an object payload, status === 'applied', and every expected
 * derived field present. Anything else is a failure — never a silent success and
 * never a fallback.
 */
function interpret(op: string, error: unknown, data: unknown, requiredKeys: readonly string[]): EngineResult {
  if (error) {
    const msg = (error as { message?: unknown })?.message;
    return { ok: false, op, reason: "rpc_transport_error", raw: typeof msg === "string" ? msg : error };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, op, reason: "malformed_result", raw: data };
  }
  const res = data as Record<string, unknown>;
  if (res.status === "error") {
    return { ok: false, op, reason: typeof res.reason === "string" ? res.reason : "error", raw: res };
  }
  if (res.status !== "applied") {
    return { ok: false, op, reason: "unexpected_status", raw: res };
  }
  for (const k of requiredKeys) {
    if (!(k in res) || res[k] === null || res[k] === undefined) {
      return { ok: false, op, reason: "missing_result_field", raw: res };
    }
  }
  return { ok: true, op, data: res };
}

// ── Supported operations (real wrappers over the INV.3C atomic RPCs) ──────────

/** Apply a ± delta to one variant's stock; parent rolls up atomically (RPC). */
export async function adjustVariant(admin: any, variantId: string, delta: number): Promise<EngineResult> {
  const op = "adjustVariant";
  if (!variantId) return { ok: false, op, reason: "missing_variant" };
  if (!Number.isInteger(delta)) return { ok: false, op, reason: "invalid_delta" };
  const { data, error } = await admin.rpc("inv_adjust_variant", { p_variant_id: variantId, p_delta: delta });
  return interpret(op, error, data, ["before", "after", "parentStock"]);
}

/** Set one variant to an absolute non-negative integer; parent rolls up (RPC). */
export async function setVariantAbsolute(admin: any, variantId: string, quantity: number): Promise<EngineResult> {
  const op = "setVariantAbsolute";
  if (!variantId) return { ok: false, op, reason: "missing_variant" };
  if (!Number.isInteger(quantity) || quantity < 0) return { ok: false, op, reason: "invalid_quantity" };
  const { data, error } = await admin.rpc("inv_set_variant_absolute", { p_variant_id: variantId, p_quantity: quantity });
  return interpret(op, error, data, ["before", "after", "parentStock"]);
}

/**
 * Set a SIMPLE product's inventory row to an absolute non-negative integer (RPC
 * inv_set_absolute_product). Fail-closed: a product WITH variants or WITH shelf
 * rows is rejected by the RPC (product_has_variants / product_has_shelf_rows) —
 * those grains are owned by INV.4B / INV.4C. Never a direct-write fallback.
 */
export async function setAbsolute(admin: any, inventoryId: string, quantity: number): Promise<EngineResult> {
  const op = "setAbsolute";
  if (!inventoryId) return { ok: false, op, reason: "missing_inventory" };
  if (!Number.isInteger(quantity) || quantity < 0) return { ok: false, op, reason: "invalid_quantity" };
  const { data, error } = await admin.rpc("inv_set_absolute_product", { p_inventory_id: inventoryId, p_quantity: quantity });
  return interpret(op, error, data, ["before", "after", "productId"]);
}

export type ShelfScope = "product" | "variant";

/** Authoritative shelf placement/count; recomputes derived totals (RPC). */
export async function placeOnShelf(
  admin: any,
  args: { scope: ShelfScope; targetId: string; location: string; quantity: number },
): Promise<EngineResult> {
  const op = "placeOnShelf";
  const { scope, targetId, location, quantity } = args;
  if (scope !== "product" && scope !== "variant") return { ok: false, op, reason: "invalid_scope" };
  if (!targetId) return { ok: false, op, reason: "missing_target" };
  if (!location || !location.trim()) return { ok: false, op, reason: "invalid_location" };
  if (!Number.isInteger(quantity) || quantity < 0) return { ok: false, op, reason: "invalid_quantity" };
  const { data, error } = await admin.rpc("inv_place_shelf", {
    p_scope: scope, p_target_id: targetId, p_location: location, p_quantity: quantity,
  });
  const required = scope === "product" ? ["stock", "shelfSum"] : ["variantStock", "parentStock"];
  return interpret(op, error, data, required);
}

/** Read-only reconciliation verdict for a product (delegates to reconcile.ts). */
export async function reconcile(admin: any, productId: string): Promise<ReconcileResult> {
  return reconcileProductState(admin, productId);
}

// ── Future operations — declared, but with NO implementation yet ──────────────
//
// These are part of the target engine contract but have no atomic RPC yet. They
// are intentionally NOT backed by a legacy JS read-modify-write. Each throws so
// it can never perform an unsafe mutation; the writer-migration phases add the
// real atomic implementations.

export const NOT_IMPLEMENTED_OPS = [
  "adjust",            // product-grain delta (needs an atomic product RPC)
  "sell",              // stock − + sold + shelf spread (channel symmetry, INV.5)
  "receive",           // product-grain purchase-in
  "moveShelf",         // slot → slot transfer
  "removeShelf",       // drop a slot
  "reverseMovement",   // invert a ledger movement
] as const;
// setAbsolute is implemented (INV.4A) — see the wrapper above.

export type NotImplementedOp = (typeof NOT_IMPLEMENTED_OPS)[number];

export class InventoryEngineNotImplementedError extends Error {
  readonly op: NotImplementedOp;
  constructor(op: NotImplementedOp) {
    super(`Inventory Engine op "${op}" has no atomic implementation yet (post-INV.3D). Do NOT fall back to a direct write.`);
    this.name = "InventoryEngineNotImplementedError";
    this.op = op;
  }
}

function notImplemented(op: NotImplementedOp): never {
  throw new InventoryEngineNotImplementedError(op);
}

// Throwing stubs — present in the contract, impossible to call as a mutation.
export const adjust = (..._args: unknown[]): never => notImplemented("adjust");
export const sell = (..._args: unknown[]): never => notImplemented("sell");
export const receive = (..._args: unknown[]): never => notImplemented("receive");
export const moveShelf = (..._args: unknown[]): never => notImplemented("moveShelf");
export const removeShelf = (..._args: unknown[]): never => notImplemented("removeShelf");
export const reverseMovement = (..._args: unknown[]): never => notImplemented("reverseMovement");
