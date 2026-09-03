// STEP 38 — master-scoping for the Action Center — PURE (no I/O, no clock).
//
// The Action Center mixes UNITS and DOMAINS in one list:
//
//   • PRODUCT-BOUND actions   — `entityId` is a canonical product id. These are
//     CURRENT OPERATIONAL work and belong to the active master only.
//   • GLOBAL / SYSTEM actions — `entityId` is null (a platform-health roll-up, an
//     inventory rollup, a catalog-wide finding). These have no membership
//     semantics at all and must NEVER be dropped by scoping.
//
// This module only partitions an already-built view on that distinction and
// recounts it. It defines no new action, no new lane rule and no new severity
// rule: the summary and grouping come from the SAME certified pure functions the
// unscoped view uses, so a scoped view is the certified view over a subset.
//
// Identity: `entityId` is the canonical product id emitted by the action
// sources. SKU strings are never used to infer membership.

import {
  groupActionsByType,
  summarizeActions,
  type Action,
  type ActionCenterView,
  type ActionSourceStatus,
} from "./action-model.ts";

/** Membership test for one canonical product id. */
export type IsMember = (productId: string) => boolean;

/** True when an action carries no product identity — a global/system finding. */
export function isGlobalAction(action: Pick<Action, "entityId">): boolean {
  return typeof action.entityId !== "string" || action.entityId === "";
}

/**
 * Keep GLOBAL actions always, and product-bound actions only for master members.
 *
 * `membershipOk: false` means membership could not be read. We then fail CLOSED
 * on product-derived data — every product-bound action is dropped — while global
 * system actions, which do not depend on membership, still render. A silent
 * fallback to the unscoped list would reinstate outside-master products.
 */
export function scopeActions(
  actions: readonly Action[] | null | undefined,
  isMember: IsMember,
  membershipOk = true,
): Action[] {
  if (!Array.isArray(actions)) return [];
  return actions.filter((a) => {
    if (isGlobalAction(a)) return true;
    return membershipOk && isMember(a.entityId as string);
  });
}

/**
 * Per-source counts recomputed over the SCOPED actions, so a chip reading
 * "recommendations: N" reports the N actually shown rather than a pre-scope
 * total. `ok` (reader health) is preserved verbatim — scoping never invents or
 * repairs a degraded source.
 */
export function rescopeSources(
  sources: readonly ActionSourceStatus[] | null | undefined,
  scoped: readonly Action[],
): ActionSourceStatus[] {
  if (!Array.isArray(sources)) return [];
  const counts = new Map<string, number>();
  for (const a of scoped) counts.set(a.source, (counts.get(a.source) ?? 0) + 1);
  return sources.map((s) => ({ ...s, count: counts.get(s.source) ?? 0 }));
}

/**
 * The whole view, restricted to the current master. Summary and groups are
 * rebuilt with the certified pure functions over the scoped list — never a
 * second counting rule.
 */
export function scopeActionCenterView(
  view: ActionCenterView | null | undefined,
  isMember: IsMember,
  membershipOk = true,
): ActionCenterView {
  const actions = scopeActions(view?.actions, isMember, membershipOk);
  return {
    summary: summarizeActions(actions),
    groups: groupActionsByType(actions),
    actions,
    sources: rescopeSources(view?.sources, actions),
    generatedAt: view?.generatedAt ?? null,
  };
}
