// Master-scoped readiness baseline — PURE (no I/O, no clock, no client).
//
// ONE definition of "ready to publish" shared by Home (/v2), Launch
// (/v2/catalog/launch) and Export (/v2/export), so the three surfaces can never
// report different readiness for the same catalog.
//
// Readiness itself is NOT redefined here: `readyToPublish` and the per-field
// `checks` are produced by the certified readiness engine
// (lib/operations/readiness). This module only
//   (a) restricts that certified output to the current operational master, and
//   (b) counts it.
//
// It deliberately does NOT mean `approval === 'Approved'`. Before this module
// existed, Launch and Export derived their cards from an unscoped
// approval count over every product row, which is why they reported a larger
// "ready" figure than Home over a universe that included products outside the
// master.
//
// The master size is always derived from the membership passed in — never a
// constant.

/** The slice of the certified readiness row this module needs. */
export interface ReadinessLike {
  productId: string;
  readyToPublish: boolean;
  checks: readonly { code: string; passed: boolean }[];
}

/** The membership surface (structurally compatible with home MasterScope). */
export interface MembershipLike {
  /** false when membership could not be read — callers must fail closed. */
  ok: boolean;
  ids: ReadonlySet<string>;
  /** Current master size, derived from `ids`. */
  total: number;
}

export interface MasterReadiness {
  /** Master products the readiness scan actually resolved. */
  scanned: number;
  /** Current master size (membership), independent of scan coverage. */
  masterTotal: number;
  ready: number;
  blocked: number;
  /** 0..100, or null when there is nothing to divide by. */
  percent: number | null;
  /** false when membership was unavailable — every count above is 0. */
  available: boolean;
}

/** Keep only readiness rows whose product is in the master. Fails CLOSED. */
export function scopeReadiness<T extends { productId: string }>(
  readiness: readonly T[] | null | undefined,
  membership: MembershipLike,
): T[] {
  if (!Array.isArray(readiness) || !membership.ok) return [];
  return readiness.filter((r) => typeof r.productId === "string" && membership.ids.has(r.productId));
}

/**
 * Ready / blocked / percent over the master only.
 *
 * INVARIANT: ready + blocked === scanned. `scanned` can be lower than
 * `masterTotal` when the readiness scan did not resolve every member (a capped
 * or partial read); the two are reported separately rather than reconciled, so
 * a partial scan can never masquerade as a complete one.
 */
export function computeMasterReadiness(
  readiness: readonly ReadinessLike[] | null | undefined,
  membership: MembershipLike,
): MasterReadiness {
  if (!membership.ok) {
    return { scanned: 0, masterTotal: 0, ready: 0, blocked: 0, percent: null, available: false };
  }
  const scoped = scopeReadiness(readiness, membership);
  const ready = scoped.filter((r) => r.readyToPublish === true).length;
  const scanned = scoped.length;
  return {
    scanned,
    masterTotal: membership.total,
    ready,
    blocked: scanned - ready,
    percent: scanned > 0 ? Math.round((ready / scanned) * 100) : null,
    available: true,
  };
}

/** Field-gap codes the certified readiness engine emits per product. */
export type GapCode = "image" | "price" | "category" | "brand" | "sku" | "barcode" | "name" | "variants";

/**
 * Count master products failing one certified required check. This replaces the
 * catalog-wide `count(*)` head queries that could not be restricted to
 * membership — the source of Launch's blocker counts including products outside
 * the master.
 */
export function countMasterGap(
  readiness: readonly ReadinessLike[] | null | undefined,
  membership: MembershipLike,
  code: GapCode,
): number {
  return scopeReadiness(readiness, membership).filter((r) =>
    Array.isArray(r.checks) && r.checks.some((c) => c.code === code && c.passed === false),
  ).length;
}
