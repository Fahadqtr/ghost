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

/**
 * Set one variant to an absolute non-negative integer; parent rolls up (RPC).
 *
 * The INV.3C RPC returns the parent AFTER (parentStock) only. Because the RPC
 * locks all siblings and rolls up atomically, the parent BEFORE is exactly
 * parentStock − (after − before); we derive it here so a caller (the INV.4B
 * variant stocktake writer) has an authoritative parentBefore/parentStock pair
 * for a zero-crossing transition WITHOUT re-reading the (double-counting)
 * totalStock. This is additive — the RPC is unchanged. `parentBefore` is only
 * added when before/after/parentStock are all present and well-formed.
 */
export async function setVariantAbsolute(admin: any, variantId: string, quantity: number): Promise<EngineResult> {
  const op = "setVariantAbsolute";
  if (!variantId) return { ok: false, op, reason: "missing_variant" };
  if (!Number.isInteger(quantity) || quantity < 0) return { ok: false, op, reason: "invalid_quantity" };
  const { data, error } = await admin.rpc("inv_set_variant_absolute", { p_variant_id: variantId, p_quantity: quantity });
  const res = interpret(op, error, data, ["before", "after", "parentStock"]);
  if (res.ok) {
    const before = Number(res.data.before);
    const after = Number(res.data.after);
    const parentStock = Number(res.data.parentStock);
    if (Number.isFinite(before) && Number.isFinite(after) && Number.isFinite(parentStock)) {
      res.data.parentBefore = parentStock - (after - before);
    }
  }
  return res;
}

/**
 * Apply a ± delta to ONE variant's stock with the parent rollup AND an optional
 * sold_quantity increment, ALL atomically (RPC inv_adjust_variant_movement). The
 * sole path for the INV.4B variant movement writers (recordVariantMovement,
 * staffMoveVariant).
 *
 * `soldDelta` MUST be either 0 (no sold change) or, for a sale-out, exactly the
 * quantity going out (delta < 0 and soldDelta = -delta); the RPC enforces this
 * fail-closed. Fail-closed like every wrapper: transport error / status:error /
 * malformed / a missing required derived field is a FAILURE — never a fallback to
 * a direct JS write. Required success fields: variantId, productId, before, after,
 * parentBefore, parentStock, soldBefore, soldAfter.
 */
export async function adjustVariantMovement(
  admin: any,
  args: { variantId: string; delta: number; soldDelta: number },
): Promise<EngineResult> {
  const op = "adjustVariantMovement";
  const { variantId, delta, soldDelta } = args;
  if (!variantId) return { ok: false, op, reason: "missing_variant" };
  if (!Number.isInteger(delta) || delta === 0) return { ok: false, op, reason: "invalid_delta" };
  if (!Number.isInteger(soldDelta) || soldDelta < 0) return { ok: false, op, reason: "invalid_sold_delta" };
  // Guard the sold contract in the wrapper too (the RPC is authoritative).
  if (soldDelta > 0 && !(delta < 0 && soldDelta === -delta)) {
    return { ok: false, op, reason: "sold_delta_mismatch" };
  }
  const { data, error } = await admin.rpc("inv_adjust_variant_movement", {
    p_variant_id: variantId, p_delta: delta, p_sold_delta: soldDelta,
  });
  return interpret(op, error, data, [
    "variantId", "productId", "before", "after", "parentBefore", "parentStock", "soldBefore", "soldAfter",
  ]);
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
export type ShelfRow = { location: string; quantity: number };

/**
 * INV.4D — atomic editor variant sync (RPC sync_product_variants). Unlike the
 * other Engine ops this RPC is SECURITY INVOKER, so it takes the SESSION client
 * (RLS applies) — NOT the service-role admin client. It performs the variant
 * update/insert/delete AND the atomic parent inventory rollup (inventory.stock =
 * Σ variants) in one transaction. Fail-closed: transport error, malformed body,
 * ok!==true (the RPC's fixed error code is surfaced verbatim as `reason`), or a
 * missing parent total is a FAILURE — never a fallback. `variants` is the
 * already-projected payload (see toVariantPayload in product-save.ts).
 */
export async function syncEditorVariants(
  sessionClient: any,
  productId: string,
  variants: unknown[],
): Promise<EngineResult> {
  const op = "syncEditorVariants";
  if (!productId) return { ok: false, op, reason: "missing_target" };
  if (!Array.isArray(variants)) return { ok: false, op, reason: "invalid_rows" };
  const { data, error } = await sessionClient.rpc("sync_product_variants", {
    p_product_id: productId, p_variants: variants,
  });
  if (error) {
    const msg = (error as { message?: unknown })?.message;
    return { ok: false, op, reason: "rpc_transport_error", raw: typeof msg === "string" ? msg : error };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, op, reason: "malformed_result", raw: data };
  }
  const res = data as Record<string, unknown>;
  if (res.ok !== true) {
    return { ok: false, op, reason: typeof res.error === "string" ? res.error : "variant_sync_failed", raw: res };
  }
  for (const k of ["hasVariants", "parentBefore", "variantChanges"]) {
    if (!(k in res) || res[k] === null || res[k] === undefined) {
      return { ok: false, op, reason: "missing_result_field", raw: res };
    }
  }
  return { ok: true, op, data: res };
}

// Required non-null result fields per scope. primaryLocation / location are
// deliberately EXCLUDED — they are legitimately null (no placement / untrack), and
// interpret() treats null as a missing field.
const SHELF_REQUIRED = {
  product: ["stockBefore", "stock", "shelfSum"] as const,
  variant: ["variantBefore", "variantStock", "parentBefore", "parentStock"] as const,
};

/**
 * Authoritative single-slot shelf placement/count (RPC inv_place_shelf). This is a
 * DISTRIBUTION EDIT (type A): setting a slot to 0 removes it and re-derives stock
 * from Σ shelves (removing the last placement re-derives stock to 0 — that is a
 * count, not an untrack; use replaceShelfDistribution([]) / assignFullShelf("") to
 * UNTRACK while preserving stock). Product also syncs inventory.location = primary.
 */
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
  return interpret(op, error, data, SHELF_REQUIRED[scope]);
}

/**
 * Remove ONE slot placement (type A edit) — a thin alias over placeOnShelf(quantity:0)
 * with the identical contract: re-derives stock from Σ remaining shelves.
 */
export async function removeShelf(
  admin: any,
  args: { scope: ShelfScope; targetId: string; location: string },
): Promise<EngineResult> {
  return placeOnShelf(admin, { ...args, quantity: 0 });
}

/**
 * Replace the WHOLE shelf distribution atomically (RPC inv_replace_shelf_distribution).
 * Non-empty rows → stock = Σ rows, location = primary. An EMPTY rows array is an
 * explicit UNTRACK: drop the overlay, location=null, PRESERVE the current stock.
 * Fail-closed. Duplicate locations are merged (summed) by the RPC.
 */
export async function replaceShelfDistribution(
  admin: any,
  args: { scope: ShelfScope; targetId: string; rows: ShelfRow[] },
): Promise<EngineResult> {
  const op = "replaceShelfDistribution";
  const { scope, targetId, rows } = args;
  if (scope !== "product" && scope !== "variant") return { ok: false, op, reason: "invalid_scope" };
  if (!targetId) return { ok: false, op, reason: "missing_target" };
  if (!Array.isArray(rows)) return { ok: false, op, reason: "invalid_rows" };
  const { data, error } = await admin.rpc("inv_replace_shelf_distribution", {
    p_scope: scope, p_target_id: targetId, p_rows: rows,
  });
  return interpret(op, error, data, SHELF_REQUIRED[scope]);
}

/**
 * Place the whole current stock (quantity omitted) or a forced quantity into ONE
 * slot, atomically (RPC inv_assign_full_shelf). An empty/blank location is an
 * explicit UNTRACK (clear overlay, location=null, preserve stock unless a quantity
 * is forced). quantity 0 → no shelf row + location null, stock forced to 0.
 */
export async function assignFullShelf(
  admin: any,
  args: { scope: ShelfScope; targetId: string; location: string | null; quantity?: number | null },
): Promise<EngineResult> {
  const op = "assignFullShelf";
  const { scope, targetId, location } = args;
  const quantity = args.quantity ?? null;
  if (scope !== "product" && scope !== "variant") return { ok: false, op, reason: "invalid_scope" };
  if (!targetId) return { ok: false, op, reason: "missing_target" };
  if (quantity !== null && (!Number.isInteger(quantity) || quantity < 0)) {
    return { ok: false, op, reason: "invalid_quantity" };
  }
  const { data, error } = await admin.rpc("inv_assign_full_shelf", {
    p_scope: scope, p_target_id: targetId, p_location: location ?? "", p_quantity: quantity,
  });
  // assign_full_shelf returns no shelfSum (single-slot), so require the stock pair.
  const required = scope === "product"
    ? ["stockBefore", "stock"] as const
    : ["variantBefore", "variantStock", "parentBefore", "parentStock"] as const;
  return interpret(op, error, data, required);
}

/**
 * Move a whole placement from one slot to another, merging into `to` if it exists
 * (RPC inv_move_shelf). Total stock (product) / variant + parent (variant) is
 * invariant; primary recomputed. Fail-closed if the source placement is absent.
 */
export async function moveShelf(
  admin: any,
  args: { scope: ShelfScope; targetId: string; fromLocation: string; toLocation: string },
): Promise<EngineResult> {
  const op = "moveShelf";
  const { scope, targetId, fromLocation, toLocation } = args;
  if (scope !== "product" && scope !== "variant") return { ok: false, op, reason: "invalid_scope" };
  if (!targetId) return { ok: false, op, reason: "missing_target" };
  if (!fromLocation || !fromLocation.trim() || !toLocation || !toLocation.trim()) {
    return { ok: false, op, reason: "invalid_location" };
  }
  const { data, error } = await admin.rpc("inv_move_shelf", {
    p_scope: scope, p_target_id: targetId, p_from_location: fromLocation, p_to_location: toLocation,
  });
  const required = scope === "product" ? ["quantity", "stock"] as const : ["quantity", "variantStock", "parentStock"] as const;
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
  "reverseMovement",   // invert a ledger movement
] as const;
// setAbsolute is implemented (INV.4A); adjustVariantMovement (INV.4B);
// placeOnShelf / removeShelf / replaceShelfDistribution / assignFullShelf /
// moveShelf are implemented (INV.4C) — see the wrappers above.

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
export const reverseMovement = (..._args: unknown[]): never => notImplemented("reverseMovement");
