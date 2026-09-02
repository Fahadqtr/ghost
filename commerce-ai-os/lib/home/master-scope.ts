// Malikas operational master scope — PURE helpers (no I/O, no clock, no client).
//
// The operational product universe is the set of products holding an ACTIVE
// `snoonu:malikas` row in `external_channel_listings`. Its size is derived from
// the data on every request — never a constant. These helpers only filter
// already-loaded rows against that set; the membership itself is read by
// `master-scope.server.ts`.
//
// Scoping is a READ-side concern only: products outside the master stay in the
// database untouched, they are simply not counted in current operational
// metrics.

/** Membership of the current operational master. `ok: false` = read failed. */
export interface MasterScope {
  /** false when membership could not be read — callers must fail closed. */
  ok: boolean;
  /** Product ids in the active snoonu:malikas master. */
  ids: ReadonlySet<string>;
  /** Master size, derived from `ids` — never hardcoded. */
  total: number;
}

/** A scope that could not be read. Never treat this as "everything". */
export const UNAVAILABLE_SCOPE: MasterScope = { ok: false, ids: new Set<string>(), total: 0 };

/** Build a scope from raw listing rows, keeping only usable string product ids. */
export function buildMasterScope(rows: readonly unknown[] | null | undefined): MasterScope {
  const ids = new Set<string>();
  if (Array.isArray(rows)) {
    for (const row of rows) {
      if (typeof row !== "object" || row === null || Array.isArray(row)) continue;
      const pid = (row as Record<string, unknown>).product_id;
      if (typeof pid === "string" && pid.length > 0) ids.add(pid);
    }
  }
  return { ok: true, ids, total: ids.size };
}

/** True when `id` is a member. A non-string id is never a member. */
export function isMember(scope: MasterScope, id: unknown): boolean {
  return typeof id === "string" && id.length > 0 && scope.ids.has(id);
}

/**
 * Keep only rows whose id is in the master. An unreadable scope yields an EMPTY
 * list, never the unfiltered input — a silent fallback would report every
 * product as though it belonged to the master.
 */
export function scopeRows<T>(rows: readonly T[] | null | undefined, getId: (row: T) => unknown, scope: MasterScope): T[] {
  if (!Array.isArray(rows) || !scope.ok) return [];
  return rows.filter((row) => isMember(scope, getId(row)));
}

/**
 * Keep rows that are either master members OR carry no entity at all
 * (catalog-wide findings, which are not about one product and stay visible).
 */
export function scopeRowsKeepingGlobal<T>(
  rows: readonly T[] | null | undefined,
  getId: (row: T) => unknown,
  scope: MasterScope,
): T[] {
  if (!Array.isArray(rows) || !scope.ok) return [];
  return rows.filter((row) => {
    const id = getId(row);
    return id === null || id === undefined || id === "" ? true : isMember(scope, id);
  });
}
