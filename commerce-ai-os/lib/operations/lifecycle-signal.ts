// OPS.8B — read-only lifecycle breakdown for the Operations Center. PURE.
//
// A counting projection over items the dashboard ALREADY loaded — it reuses the
// lifecycle read model (resolveLifecycleState + displayLifecycle) and adds no
// new queue, no new scan, and no writes. READY is derived (a DRAFT whose
// readiness is "ready"); ARCHIVED never appears here (live items only).

import { resolveLifecycleState } from "../lifecycle/state.ts";
import { displayLifecycle } from "../lifecycle/transitions.ts";

export interface LifecycleSignalItem {
  lifecycleState?: string | null;
  platformStatus?: string | null;
  readinessStatus?: string;
}

export interface LifecycleBreakdown {
  draft: number;
  ready: number;
  active: number;
  stopped: number;
  /** ARCHIVED is DERIVED from product_archive (cold storage) — passed in, never
   *  scanned here (OPS.8C §9: reuse the archive count, no second scanner). */
  archived: number;
  /** live product total (excludes archived). */
  total: number;
}

/**
 * Count live products by DERIVED display state. `archivedCount` comes from the
 * existing product_archive source (reused, not re-scanned) — ARCHIVED products
 * have no live row so they can only be counted from cold storage.
 */
export function buildLifecycleBreakdown(
  items: readonly LifecycleSignalItem[] | null | undefined,
  archivedCount = 0,
): LifecycleBreakdown {
  const b: LifecycleBreakdown = {
    draft: 0,
    ready: 0,
    active: 0,
    stopped: 0,
    archived: Number.isFinite(archivedCount) && archivedCount > 0 ? Math.floor(archivedCount) : 0,
    total: 0,
  };
  if (!Array.isArray(items)) return b;
  for (const it of items) {
    const state = resolveLifecycleState({
      lifecycle_state: it?.lifecycleState,
      platform_status: it?.platformStatus,
    });
    const display = displayLifecycle(state, { ready: it?.readinessStatus === "ready", archived: false });
    b.total++;
    if (display === "READY") b.ready++;
    else if (display === "ACTIVE") b.active++;
    else if (display === "STOPPED") b.stopped++;
    else b.draft++; // DRAFT
  }
  return b;
}
