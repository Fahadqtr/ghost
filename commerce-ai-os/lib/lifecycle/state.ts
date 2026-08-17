// OPS.8A — product lifecycle read-compat (PURE).
//
// The canonical PRODUCT-level lifecycle is a small, closed domain. READY is
// DERIVED (a complete + approved DRAFT), ARCHIVED is DERIVED from product_archive
// (an archived product has no live row), and PUBLISHED / HIDDEN are per-STOREFRONT
// channel concepts — none of them are ever stored in products.lifecycle_state.
//
// During the migration, prefer the new `lifecycle_state` column and fall back to
// the legacy `platform_status` mapping so consumers stay correct either way.
// Framework-free, no IO — node:test loads it directly.

export const LIFECYCLE_STATES = ["DRAFT", "ACTIVE", "STOPPED"] as const;
export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

export function isLifecycleState(v: unknown): v is LifecycleState {
  return typeof v === "string" && (LIFECYCLE_STATES as readonly string[]).includes(v);
}

/**
 * Legacy `products.platform_status` → lifecycle_state. `'Active'` → `ACTIVE`;
 * everything else (Draft / null / blank / any non-Active) → `DRAFT`. STOPPED has
 * no legacy source; ARCHIVED/READY/PUBLISHED/HIDDEN are never produced here.
 */
export function mapLegacyStatus(platformStatus: unknown): LifecycleState {
  return platformStatus === "Active" ? "ACTIVE" : "DRAFT";
}

/** Prefer the canonical lifecycle_state; fall back to the legacy mapping. */
export function resolveLifecycleState(
  row: { lifecycle_state?: unknown; platform_status?: unknown } | null | undefined,
): LifecycleState {
  if (row && isLifecycleState(row.lifecycle_state)) return row.lifecycle_state;
  return mapLegacyStatus(row?.platform_status);
}

/**
 * READY is a DERIVED sub-state, never stored: a DRAFT product that is
 * catalog-complete AND approved. Callers pass the already-computed booleans
 * (readiness engine + approval flag) — this adds no detection of its own.
 */
export function isReady(
  state: LifecycleState,
  opts: { readinessComplete: boolean; approved: boolean },
): boolean {
  return state === "DRAFT" && opts.readinessComplete === true && opts.approved === true;
}
