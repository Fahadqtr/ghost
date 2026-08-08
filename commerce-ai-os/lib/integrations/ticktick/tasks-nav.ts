// Malikas V2 — /v2/tasks single-task redirect builder. PURE: no I/O, no secrets.
//
// The owner-only per-task TickTick preview/sync are server actions that redirect
// back to /v2/tasks with a result param the page renders. The bug this fixes:
// those redirects USED to drop the owner's current view (filter/search/page), so
// after the round-trip the previewed card was no longer on the (reset) page and
// the preview box never showed — it looked like the button did nothing. This
// re-emits the current view alongside the result params so the result lands on
// the SAME card the owner clicked.

/** The view fields we round-trip — exactly the ones parseTaskControls reads.
 *  Anything else in `view` is ignored (no arbitrary params are reflected). */
const VIEW_KEYS = ["query", "filter", "page"] as const;

/**
 * Build a /v2/tasks redirect that preserves the caller's current list view
 * (query/filter/page, parsed from `view`) and adds the result params in `extra`
 * (e.g. `{ ttplan, pa }` for a preview, or `{ ticktick }` for a status banner).
 * Pure and deterministic — safe to unit-test with no network.
 */
export function tasksRedirect(
  view: string | undefined,
  extra: Record<string, string>,
): string {
  const p = new URLSearchParams();
  const src = new URLSearchParams(view ?? "");
  for (const k of VIEW_KEYS) {
    const v = src.get(k);
    if (v) p.set(k, v);
  }
  for (const [k, v] of Object.entries(extra)) {
    if (v !== "") p.set(k, v);
  }
  const qs = p.toString();
  return qs ? `/v2/tasks?${qs}` : "/v2/tasks";
}
