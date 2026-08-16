// CH.6C — availability apply planning + idempotency (PURE).
//
// From confirmed diff rows + a FRESH read of internal availability at apply time,
// decide the per-product plan. Only selected, actionable CHANGE rows proceed; a
// product whose internal availability already matches the target now is left
// UNCHANGED (idempotent / stale-preview protection). The orchestrator executes
// the write through the Availability Engine.
//
// PURE: imports only pure siblings. node:test loads it.

import { type AvailabilityState } from "../../../availability/read.ts";
import { type AvailabilityDiffRow } from "./snoonu-availability-diff.ts";

export type PlanAction = "apply" | "unchanged" | "skip";

export interface AvailabilityPlanItem {
  productId: string;
  action: PlanAction;
  targetState: AvailabilityState | null;
  reason: string;
}

export interface AvailabilityPlanInput {
  rows: AvailabilityDiffRow[];
  selected: Set<string>;
  /** FRESH internal availability at apply time: productId → current state. */
  currentNow: Map<string, AvailabilityState | null>;
}

export function planAvailabilityApply(input: AvailabilityPlanInput): AvailabilityPlanItem[] {
  const out: AvailabilityPlanItem[] = [];
  for (const r of input.rows) {
    if (!input.selected.has(r.productId)) continue;
    if (!r.actionable || !r.targetState) {
      out.push({ productId: r.productId, action: "skip", targetState: null, reason: "not an applicable change" });
      continue;
    }
    if (input.currentNow.get(r.productId) === r.targetState) {
      out.push({ productId: r.productId, action: "unchanged", targetState: r.targetState, reason: "internal already matches (stale preview / idempotent)" });
      continue;
    }
    out.push({ productId: r.productId, action: "apply", targetState: r.targetState, reason: r.reason });
  }
  return out;
}
