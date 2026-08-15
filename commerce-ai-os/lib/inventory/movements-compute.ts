// Stock-movement arithmetic — pure, DB-free core.
//
// INV.6A: the movement engine (movements.ts) is now CONVERGED onto the atomic
// Inventory Engine RPCs, which compute every authoritative before/after in SQL
// (BIGINT, fail-closed, NO clamp). The old clamp-based JS planners planEdit /
// planDelete (which used Math.max(0, …)) are RETIRED — nothing in the runtime
// computes an authoritative movement result in TypeScript anymore. Only the
// input-normalization helper and the legacy clamp-free apply planner remain,
// re-exported from the canonical compute layer for the remaining callers/tests.
//
// NOTE ON REASON MATCHING (mirrors the original engine + the RPC exactly): a
// movement counts as a sale case-insensitively ("sale"/"Sale"/"SALE"); the RPC
// normalizes and stores the exact "sale" so edit/delete adjust sold_quantity
// only for the stored canonical reason.

// Canonical movement-normalization/apply math lives in compute.ts. Re-exporting
// preserves the existing public API and runtime behavior. planApply is
// clamp-free (it returns an error rather than clamping a negative result).
export { normalizeQty, planApply } from "./compute.ts";
export type { ApplyPlan } from "./compute.ts";
